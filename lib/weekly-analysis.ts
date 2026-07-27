// Еженедельный анализ комментов бренда.
//
// Что делает:
//   1. Читает analytics/threads-report.md (полный архив комментов) +
//      собирает свежие метрики постов за последние 7 дней (Insights API)
//   2. Sonnet группирует похожие комменты по темам и считает evidence_count
//      (сколько разных юзеров сказали похожее)
//   3. Findings: только темы с ≥CONFIRMED_THRESHOLD разных юзеров.
//      Weak signals: 1..(CONFIRMED_THRESHOLD-1) разных юзеров — отдельно.
//   4. Findings → дописываются в queue/castdev_findings.md (бот их видит)
//   5. Weak signals → отдельный файл analytics/weak-signals.md (для просмотра)
//   6. Отчёт в Telegram
//
// Главное правило: один коммент ≠ инсайт. Минимум CONFIRMED_THRESHOLD
// разных пользователей должны сказать похожее, иначе это weak signal.
import { listQueue } from './queue';
import { getPostReplies } from './threads';
import { getBrandVoicePrompt } from './brand';
import { getFile, putFile } from './github';
import { readArchive } from './comments-archive';
import { handleAt } from './brand-config';
import { codexChat } from './codex-chat';

// Минимум разных юзеров чтобы тема стала подтверждённым finding.
// Если у тебя выйдет, что findings никогда не появляются — снизить до 3.
// Если слишком много мусорных — поднять до 7.
export const CONFIRMED_THRESHOLD = 5;

interface PostMetric {
  filename: string;
  goal: string;
  text_en_short: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  shares: number;
}

const INSIGHTS_FIELDS = 'views,likes,replies,reposts,shares';

async function fetchInsights(postId: string): Promise<PostMetric extends infer T ? Omit<PostMetric, 'filename' | 'goal' | 'text_en_short'> : never> {
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) throw new Error('THREADS_ACCESS_TOKEN не задан');
  const url = `https://graph.threads.net/v1.0/${postId}/insights?metric=${INSIGHTS_FIELDS}&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return { views: 0, likes: 0, replies: 0, reposts: 0, shares: 0 } as any;
  const data = (await res.json()) as { data: Array<{ name: string; values: Array<{ value: number }> }> };
  const out: any = { views: 0, likes: 0, replies: 0, reposts: 0, shares: 0 };
  for (const m of data.data ?? []) out[m.name] = m.values?.[0]?.value ?? 0;
  return out;
}

export async function collectWeeklyMetrics(daysBack = 7): Promise<PostMetric[]> {
  const items = await listQueue();
  const cutoff = Date.now() - daysBack * 86400_000;
  const posted = items.filter((it) => {
    if (String(it.frontmatter.status ?? '').toLowerCase() !== 'posted') return false;
    const pa = String(it.frontmatter.published_at ?? '');
    if (!pa) return false;
    const t = new Date(pa.replace(' ', 'T') + 'Z').getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });

  const metrics: PostMetric[] = [];
  for (const it of posted) {
    const postId = String(it.frontmatter.threads_post_id ?? '');
    if (!postId) continue;
    let insights = { views: 0, likes: 0, replies: 0, reposts: 0, shares: 0 };
    try {
      insights = await fetchInsights(postId);
    } catch {}
    metrics.push({
      filename: it.path.split('/').pop() ?? it.path,
      goal: String(it.frontmatter.goal ?? '(не указан)'),
      text_en_short: (it.posts[0] ?? '').slice(0, 200),
      ...insights,
    });
  }
  return metrics;
}

// ---- Анализ ----

export interface FindingItem {
  text: string;
  module: 'M1_barriers' | 'M2_jtbd' | 'other';
  evidence_count: number;
  evidence_users: string[]; // имена юзеров для проверяемости
  example_quotes: string[]; // 2-3 коротких цитаты
}

export interface WeeklyReport {
  summary_md: string; // для Telegram
  confirmed_findings: FindingItem[]; // evidence_count >= CONFIRMED_THRESHOLD
  weak_signals: FindingItem[]; // evidence_count < CONFIRMED_THRESHOLD
  meta: {
    archive_size_chars: number;
    metrics_count: number;
    total_themes_found: number;
  };
}

export async function analyzeArchive(metrics: PostMetric[]): Promise<WeeklyReport> {
  const archive = await readArchive();
  if (!archive || archive.trim().length < 100) {
    return {
      summary_md: '📭 Архив комментов пуст — нечего анализировать.',
      confirmed_findings: [],
      weak_signals: [],
      meta: { archive_size_chars: 0, metrics_count: metrics.length, total_themes_found: 0 },
    };
  }

  const metricsBlock = metrics.length > 0
    ? metrics
        .sort((a, b) => b.views - a.views)
        .map(
          (m) =>
            `- [${m.goal}] ${m.filename} · views=${m.views} likes=${m.likes} replies=${m.replies}\n  ${m.text_en_short}`
        )
        .join('\n')
    : '(метрик за неделю нет — анализируем только архив)';

  // Архив может быть большой — режем до разумного размера для LLM.
  // ~30k chars ≈ 7-8k токенов, оставляем запас на ответ.
  const archiveSlice = archive.length > 30000 ? archive.slice(-30000) : archive;

  const userPrompt = `
Ты анализируешь архив комментов под постами ${handleAt()} в Threads.

# Главное правило
Один коммент ≠ инсайт. Тема становится FINDING только если её сказали
**${CONFIRMED_THRESHOLD} или больше РАЗНЫХ юзеров** разными словами.
Если 1-${CONFIRMED_THRESHOLD - 1} человек — это WEAK SIGNAL (отдельно).

# Метрики постов за последние 7 дней
${metricsBlock}

# Архив комментов (последние 30k символов)
${archiveSlice}

# Что от тебя требуется

Группируй комменты по СМЫСЛОВЫМ темам. Не по постам, не по тегам — по тому
что человек по сути сказал. Примеры тем (формат — подставь под свой продукт):
- "[как человек сейчас решает проблему своим способом]" (текущая привычка)
- "[чего боится / что его тревожит в результате]" (anxiety про результат)
- "[какую большую цель преследует]" (JTBD: ради чего)
- "у меня нет времени этим заняться" (барьер: время)
- "[почему думает, что у него не получится]" (anxiety про себя)

Для каждой темы посчитай evidence_count = число РАЗНЫХ юзеров (не упоминаний).
Один юзер сказал 3 раза одно и то же — это evidence_count=1.

Категоризуй каждую тему:
- "M1_barriers" — про барьеры/тревоги/привычку которая держит
- "M2_jtbd" — про какую работу нанимают продукт (ради чего им пользуются)
- "other" — про что-то ещё (язык/стиль/обратная связь по продукту/etc)

Верни JSON:
{
  "summary_md": "markdown для Telegram, 8-15 строк. Сводка + что зашло + рекомендации",
  "themes": [
    {
      "text": "Чёткая формулировка темы одним предложением",
      "module": "M1_barriers" | "M2_jtbd" | "other",
      "evidence_count": <число разных юзеров>,
      "evidence_users": ["user1", "user2", ...],
      "example_quotes": ["короткая цитата 1", "короткая цитата 2"]
    },
    ...
  ]
}

Важно:
- evidence_users ДОЛЖНЫ быть РАЗНЫМИ юзернеймами (один юзер ≠ повторное подтверждение)
- НЕ ВЫДУМЫВАЙ юзернеймы — бери из архива
- Если тема не набирает ${CONFIRMED_THRESHOLD} разных юзеров — всё равно включи её в themes,
  я сам разделю на confirmed/weak по порогу
- Если архив крошечный и тем мало — не натягивай, верни сколько есть

Только JSON, без пояснений.
`.trim();

  let raw = (
    await codexChat(
      [
        { role: 'system', content: await getBrandVoicePrompt() },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 4000, jsonMode: true }
    )
  ).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) raw = fenced[1];

  const parsed = JSON.parse(raw) as {
    summary_md: string;
    themes: Array<{
      text: string;
      module: 'M1_barriers' | 'M2_jtbd' | 'other';
      evidence_count: number;
      evidence_users: string[];
      example_quotes: string[];
    }>;
  };

  const themes = (parsed.themes ?? []).map((t) => ({
    text: t.text ?? '',
    module: t.module ?? 'other',
    evidence_count: Number(t.evidence_count ?? 0),
    evidence_users: Array.isArray(t.evidence_users) ? t.evidence_users : [],
    example_quotes: Array.isArray(t.example_quotes) ? t.example_quotes : [],
  })) as FindingItem[];

  // Делим по порогу. Используем размер уникальных evidence_users — он надёжнее
  // чем доверять evidence_count модели.
  const confirmed: FindingItem[] = [];
  const weak: FindingItem[] = [];
  for (const t of themes) {
    const uniqueUsers = new Set(t.evidence_users.map((u) => u.toLowerCase().replace(/^@/, ''))).size;
    const realCount = Math.max(uniqueUsers, 0);
    t.evidence_count = realCount; // переопределяем на основе реальных уникальных
    if (realCount >= CONFIRMED_THRESHOLD) confirmed.push(t);
    else weak.push(t);
  }

  return {
    summary_md: parsed.summary_md ?? '',
    confirmed_findings: confirmed,
    weak_signals: weak,
    meta: {
      archive_size_chars: archive.length,
      metrics_count: metrics.length,
      total_themes_found: themes.length,
    },
  };
}

// =====================================================================
// Запись findings в queue/castdev_findings.md (с evidence для проверяемости)
// =====================================================================
export async function appendConfirmedFindings(report: WeeklyReport): Promise<{ added: number }> {
  const newFindings = report.confirmed_findings.filter((f) => f.module !== 'other');
  if (newFindings.length === 0) return { added: 0 };

  const file = await getFile('queue/castdev_findings.md');
  if (!file) return { added: 0 };

  // Парсим что уже есть чтобы не задублировать
  const existingLines = new Set<string>();
  for (const line of file.content.split('\n')) {
    const m = /^[-*]\s+(.+)$/.exec(line.trim());
    if (m) existingLines.add(m[1].slice(0, 80).toLowerCase());
  }

  let content = file.content;
  let added = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const f of newFindings) {
    const formatted = `${f.text} (n=${f.evidence_count}: ${f.evidence_users.slice(0, 5).join(', ')}${f.evidence_users.length > 5 ? '…' : ''})`;
    const key = formatted.slice(0, 80).toLowerCase();
    if (existingLines.has(key)) continue;

    const sectionRe = f.module === 'M1_barriers'
      ? /(## M1_barriers\n[\s\S]*?)(?=\n## |$)/
      : /(## M2_jtbd\n[\s\S]*?)(?=\n## |$)/;
    const match = sectionRe.exec(content);
    if (match) {
      content = content.replace(sectionRe, `${match[1].trimEnd()}\n- ${formatted}\n`);
      added++;
    }
  }

  // Лог-секция в конец, кто и когда обновлял
  content += `\n\n<!-- Weekly analysis ${today}: ${added} confirmed findings added (threshold=${CONFIRMED_THRESHOLD}) -->\n`;

  if (added > 0) {
    await putFile('queue/castdev_findings.md', content, `findings: +${added} confirmed (${today})`, file.sha);
  }
  return { added };
}

// =====================================================================
// Запись weak signals в отдельный файл (для просмотра, не для бота)
// =====================================================================
export async function writeWeakSignals(report: WeeklyReport): Promise<void> {
  if (report.weak_signals.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const block = report.weak_signals
    .map(
      (w) =>
        `- **${w.text}** (n=${w.evidence_count}, ${w.module})\n` +
        `  - users: ${w.evidence_users.join(', ')}\n` +
        `  - quotes: ${w.example_quotes.slice(0, 2).map((q) => `"${q}"`).join('; ')}`
    )
    .join('\n');

  const path = 'analytics/weak-signals.md';
  const file = await getFile(path).catch(() => null);
  const header = `# Weak Signals\n\nСигналы от 1-${CONFIRMED_THRESHOLD - 1} юзеров (недостаточно для finding).\nКогда наберут ${CONFIRMED_THRESHOLD}+ — попадут в queue/castdev_findings.md автоматически.\n\n---\n`;
  const append = `\n## ${today}\n\n${block}\n`;
  const newContent = file ? file.content.trimEnd() + '\n' + append : header + append;
  await putFile(path, newContent, `weak-signals ${today}`, file?.sha);
}
