// Cron — раз в неделю (понедельник 4:00 UTC = 9:00 МСК = 9:00 Ташкент).
// Также можно дёргать руками через /analyze в Telegram.
import { NextResponse } from 'next/server';
import { handleAt } from '@/lib/brand-config';
import {
  collectWeeklyMetrics,
  analyzeArchive,
  appendConfirmedFindings,
  writeWeakSignals,
  CONFIRMED_THRESHOLD,
} from '@/lib/weekly-analysis';
import { sendTelegram } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 240;

function verifyAuth(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!verifyAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const metrics = await collectWeeklyMetrics(7);
    const report = await analyzeArchive(metrics);

    // Лог в Telegram
    const header =
      `📊 <b>Weekly ${handleAt()}</b>\n` +
      `Архив: ${(report.meta.archive_size_chars / 1000).toFixed(1)}k символов | ` +
      `постов за неделю: ${report.meta.metrics_count} | ` +
      `тем найдено: ${report.meta.total_themes_found}\n` +
      `<b>✅ Confirmed (≥${CONFIRMED_THRESHOLD} разных юзеров): ${report.confirmed_findings.length}</b>\n` +
      `<i>Weak signals (1-${CONFIRMED_THRESHOLD - 1} юзера): ${report.weak_signals.length}</i>\n\n`;
    await sendTelegram(header + markdownToTelegramHtml(report.summary_md), { disablePreview: true });

    // Confirmed findings — отдельным сообщением, чтобы было видно с цитатами
    if (report.confirmed_findings.length > 0) {
      const findingsBlock = report.confirmed_findings
        .filter((f) => f.module !== 'other')
        .map((f) => {
          const quotes = f.example_quotes.slice(0, 2).map((q) => `<i>«${escapeHtml(q)}»</i>`).join(' · ');
          return (
            `<b>[${f.module}]</b> ${escapeHtml(f.text)}\n` +
            `n=${f.evidence_count}: ${escapeHtml(f.evidence_users.slice(0, 6).join(', '))}\n` +
            `${quotes}`
          );
        })
        .join('\n\n');
      if (findingsBlock) {
        await sendTelegram(`<b>💡 Confirmed findings:</b>\n\n${findingsBlock}`, { disablePreview: true });
      }
    }

    // Записать confirmed в castdev_findings.md
    const { added } = await appendConfirmedFindings(report);

    // Записать weak signals отдельно
    await writeWeakSignals(report);

    if (added > 0) {
      await sendTelegram(
        `💾 В <code>queue/castdev_findings.md</code> добавлено: <b>${added}</b> findings. Ильякова Тредс учтёт их в следующих discovery-постах.`
      );
    }

    return NextResponse.json({
      status: 'ok',
      meta: report.meta,
      confirmed: report.confirmed_findings.length,
      weak: report.weak_signals.length,
      added_to_findings: added,
    });
  } catch (e: any) {
    const msg = String(e).slice(0, 800);
    await sendTelegram(`<b>⚠️ Weekly analysis упал:</b>\n<pre>${escapeHtml(msg)}</pre>`);
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Конвертирует markdown от LLM в Telegram HTML (parse_mode=HTML).
// Поддерживает: **bold**, *italic*, _italic_, `code`, ## H2, ### H3, списки.
// Сначала экранируем HTML-спецсимволы, потом превращаем markdown в HTML-теги.
function markdownToTelegramHtml(md: string): string {
  // Шаг 1: экранируем HTML — иначе текст с < или & сломает parse_mode
  let s = escapeHtml(md);

  // Шаг 2: код в бэктиках (до bold/italic — чтобы внутри них не парсилось)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Шаг 3: bold **text** или __text__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // Шаг 4: italic *text* или _text_ (после bold, иначе съест звёздочки)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>');

  // Шаг 5: заголовки ## и ### → жирный, чтобы не было голой решётки
  s = s.replace(/^###\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^##\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^#\s+(.+)$/gm, '<b>$1</b>');

  // Шаг 6: маркеры списков — оставляем как есть, Telegram их видит как обычный текст

  return s;
}
