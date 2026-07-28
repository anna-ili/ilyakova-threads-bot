// Webhook для Telegram-бота.
// Обрабатывает:
//   - Команды: /preview, /edit, /help, /generate
//   - Кнопки на диалогах с комментами (approve/edit/skip/cancel)
//   - Кнопки на правках поста (pe_publish / pe_more / pe_cancel)
//   - Текстовые сообщения: правка драфта коммента ИЛИ правка поста
import { NextResponse } from 'next/server';
import { handleAt } from '@/lib/brand-config';
import { answerCallbackQuery, editMessageText, sendTelegram, setWebhook } from '@/lib/telegram';
import { formatDialog, formatDraft, formatPostEdit, formatPreview } from '@/lib/format';
import {
  getDialog,
  saveDialog,
  getAwaitingCorrectionId,
  setAwaitingCorrectionId,
} from '@/lib/dialog';
import {
  getPostEdit,
  savePostEdit,
  genPostEditId,
  getAwaitingPostEditId,
  setAwaitingPostEditId,
  PostEdit,
} from '@/lib/post-edit';
import {
  getDraft,
  saveDraft,
  deleteDraft,
  getAwaitingDraftId,
  setAwaitingDraftId,
  PostDraft,
} from '@/lib/post-draft';
import { editPublishedPost, reviseDraft, reviseDraftPost } from '@/lib/openrouter';
import {
  collectWeeklyMetrics,
  analyzeArchive,
  appendConfirmedFindings,
  writeWeakSignals,
  CONFIRMED_THRESHOLD,
} from '@/lib/weekly-analysis';
import { listQueue } from '@/lib/queue';
import { deletePost, publishText } from '@/lib/threads';
import { generatePost } from '@/lib/post-generator';
import { putFile, getFile } from '@/lib/github';
import { downloadTelegramPhotoToRepo } from '@/lib/photo-upload';
import {
  PhotoPending,
  genPhotoPendingId,
  getPhotoPending,
  savePhotoPending,
  deletePhotoPending,
} from '@/lib/photo-pending';
import { publishImage } from '@/lib/threads';
import {
  getOutreachItem,
  saveOutreachItem,
  getAwaitingOutreachId,
  setAwaitingOutreachId,
  markThreadSeen,
  genOutreachJobId,
  saveOutreachJob,
  type OutreachJob,
  type OutreachItem,
} from '@/lib/outreach';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PUBLISH_DELAY_MIN = 5;

function verifyWebhookSecret(req: Request): boolean {
  const sent = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return sent === expected;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: TgPhotoSize[];
    document?: { file_id: string; mime_type?: string; file_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

// GET-ручка для ОДНОРАЗОВОЙ настройки webhook.
// Открой в браузере: https://<твой-деплой>/api/bot/telegram-webhook?setup=1
// Она сама скажет Telegram'у слать апдейты на этот адрес. Без этого шага кнопки
// одобрения в боте работать НЕ будут.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('setup') !== '1') {
    return NextResponse.json({
      ok: true,
      hint: 'Чтобы подключить бота к Telegram, открой этот же адрес с ?setup=1 на конце.',
    });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан' }, { status: 500 });
  }

  // Адрес, на который Telegram будет слать апдейты — это текущий деплой.
  // Берём из заголовков запроса (works и на Vercel, и на другом хостинге).
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const base = process.env.PUBLIC_MEDIA_BASE_URL?.replace(/\/$/, '') ?? `${proto}://${host}`;
  const webhookUrl = `${base}/api/bot/telegram-webhook`;

  // Секрет для проверки подлинности апдейтов. Если задан TELEGRAM_WEBHOOK_SECRET —
  // используем его; иначе подключаем без секрета (менее безопасно, но рабоче).
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

  try {
    await setWebhook(webhookUrl, secret);
    return NextResponse.json({
      ok: true,
      message: 'Webhook подключён. Напиши боту /help — он должен ответить.',
      webhook_url: webhookUrl,
      secret_used: Boolean(secret),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: 'bad secret' }, { status: 401 });

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const allowedChat = String(process.env.TELEGRAM_CHAT_ID ?? '');
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? 0;
  if (String(chatId) !== allowedChat) {
    return NextResponse.json({ ok: true, ignored: 'chat not allowed' });
  }

  // ВАЖНО: отвечаем Telegram 200 OK СРАЗУ, а обработку выполняем БЕЗ await.
  // Иначе долгие команды (например /analyze с LLM-вызовом на 10-60с) не успевают
  // ответить за таймаут Telegram → Telegram пересылает апдейт повторно по кругу
  // (это и был зацикленный спам «Запускаю анализ» 05.06.2026).
  const handle = async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message?.photo || update.message?.document) await handlePhoto(update.message);
      else if (update.message?.text) await handleMessage(update.message);
    } catch (e: any) {
      console.error('webhook handler error:', e);
      try {
        await sendTelegram(`<b>⚠️ Ошибка webhook'а:</b>\n<pre>${String(e).slice(0, 600)}</pre>`);
      } catch {}
    }
  };

  // На Vercel обычные serverless-функции могут «засыпать» после ответа, поэтому
  // используем waitUntil, если доступен (Fluid/Edge) — иначе fire-and-forget.
  const wu = (globalThis as any)?.[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil;
  if (typeof wu === 'function') {
    wu(handle());
  } else {
    // Fire-and-forget: ответ уходит сразу, обработка догоняет в том же инстансе.
    void handle();
  }

  return NextResponse.json({ ok: true });
}

// =====================================================================
// CALLBACK (нажатие кнопки)
// =====================================================================
async function handleCallback(cb: NonNullable<TgUpdate['callback_query']>) {
  const data = cb.data ?? '';
  const [action, entityId] = data.split(':', 2);

  // Действия для редактирования постов имеют префикс pe_
  if (action.startsWith('pe_')) {
    return await handlePostEditCallback(action, entityId, cb);
  }

  // Действия для одобрения авто-сгенерированных драфтов
  if (action.startsWith('dr_')) {
    return await handleDraftCallback(action, entityId, cb);
  }

  // Действия для загруженных фото
  if (action.startsWith('ph_')) {
    return await handlePhotoCallback(action, entityId, cb);
  }

  // Действия для outreach-комментов
  if (action.startsWith('oc_')) {
    return await handleOutreachCallback(action, entityId, cb);
  }

  // Старый flow для диалогов с комментами
  return await handleDialogCallback(action, entityId, cb);
}

async function handleDialogCallback(
  action: string,
  dialogId: string,
  cb: NonNullable<TgUpdate['callback_query']>
) {
  const dialog = dialogId ? await getDialog(dialogId) : null;
  if (!dialog) {
    await answerCallbackQuery(cb.id, 'Диалог не найден или уже закрыт');
    return;
  }

  if (action === 'approve') {
    const publishAt = new Date(Date.now() + PUBLISH_DELAY_MIN * 60_000).toISOString();
    dialog.status = 'scheduled_publish';
    dialog.publish_at = publishAt;
    await saveDialog(dialog);

    await answerCallbackQuery(cb.id, `Опубликую через ${PUBLISH_DELAY_MIN} мин`);
    const { text, keyboard } = formatDialog(dialog);
    if (dialog.telegram_message_id) {
      await editMessageText(dialog.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  if (action === 'edit') {
    dialog.status = 'awaiting_correction';
    await saveDialog(dialog);
    await setAwaitingCorrectionId(dialog.id);

    await answerCallbackQuery(cb.id, 'Жду твою правку текстом');
    const { text, keyboard } = formatDialog(dialog);
    if (dialog.telegram_message_id) {
      await editMessageText(dialog.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  if (action === 'skip') {
    dialog.status = 'done';
    dialog.skip_reason = dialog.skip_reason ?? 'Пропущено вручную';
    await saveDialog(dialog);
    if ((await getAwaitingCorrectionId()) === dialog.id) await setAwaitingCorrectionId(null);

    await answerCallbackQuery(cb.id, 'Пропустила');
    if (dialog.telegram_message_id) {
      await editMessageText(
        dialog.telegram_message_id,
        formatDialog(dialog).text.replace(/Предлагаю ответить.*/s, '⏭ <i>Пропущено</i>'),
        { inlineKeyboard: [] }
      );
    }
    return;
  }

  if (action === 'cancel') {
    if (dialog.status === 'awaiting_correction') {
      dialog.status = 'awaiting_approval';
      if ((await getAwaitingCorrectionId()) === dialog.id) await setAwaitingCorrectionId(null);
      await answerCallbackQuery(cb.id, 'Отменила правку');
    } else if (dialog.status === 'scheduled_publish') {
      dialog.status = 'done';
      dialog.skip_reason = 'Публикация отменена';
      await answerCallbackQuery(cb.id, 'Публикация отменена');
    } else {
      await answerCallbackQuery(cb.id, 'Нечего отменять');
    }
    await saveDialog(dialog);
    const { text, keyboard } = formatDialog(dialog);
    if (dialog.telegram_message_id) {
      await editMessageText(dialog.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  await answerCallbackQuery(cb.id, `Неизвестное действие: ${action}`);
}

async function handlePostEditCallback(
  action: string,
  peId: string,
  cb: NonNullable<TgUpdate['callback_query']>
) {
  const pe = peId ? await getPostEdit(peId) : null;
  if (!pe) {
    await answerCallbackQuery(cb.id, 'Правка не найдена или уже закрыта');
    return;
  }

  if (action === 'pe_cancel') {
    pe.status = 'done';
    await savePostEdit(pe);
    if ((await getAwaitingPostEditId()) === pe.id) await setAwaitingPostEditId(null);
    await answerCallbackQuery(cb.id, 'Отменено');
    if (pe.telegram_message_id) {
      await editMessageText(
        pe.telegram_message_id,
        `<b>Редактирование отменено.</b>\nИсходный пост остался без изменений.`,
        { inlineKeyboard: [] }
      );
    }
    return;
  }

  if (action === 'pe_more') {
    pe.status = 'awaiting_correction';
    await savePostEdit(pe);
    await setAwaitingPostEditId(pe.id);
    await answerCallbackQuery(cb.id, 'Жду следующую правку');
    const { text, keyboard } = formatPostEdit(pe);
    if (pe.telegram_message_id) {
      await editMessageText(pe.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  if (action === 'pe_publish') {
    await answerCallbackQuery(cb.id, 'Удаляю старый, публикую новый…');
    try {
      // Удаляем старый пост (работает только если опубликован через API и <24ч)
      try {
        await deletePost(pe.threads_post_id);
      } catch (delErr: any) {
        await sendTelegram(
          `⚠️ Не смогла удалить старый пост: <pre>${String(delErr).slice(0, 300)}</pre>\n` +
            `Новый опубликую — старый придётся удалить вручную через Threads.`
        );
      }
      const published = await publishText(pe.current_text_en);
      pe.status = 'done';
      pe.threads_post_id = published.id;
      pe.threads_url = published.permalink;
      await savePostEdit(pe);
      if ((await getAwaitingPostEditId()) === pe.id) await setAwaitingPostEditId(null);

      if (pe.telegram_message_id) {
        await editMessageText(
          pe.telegram_message_id,
          `<b>✅ Пост опубликован заново.</b>\n` +
            `<a href="${published.permalink}">открыть в Threads</a>\n\n` +
            `<blockquote>${escape(pe.current_text_en)}</blockquote>`,
          { inlineKeyboard: [] }
        );
      }
    } catch (e: any) {
      await sendTelegram(`<b>⚠️ Ошибка при публикации:</b>\n<pre>${String(e).slice(0, 600)}</pre>`);
    }
    return;
  }

  await answerCallbackQuery(cb.id, `Неизвестное действие: ${action}`);
}

// HTML-экранирование для inline-использования
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =====================================================================
// MESSAGE (текст или команда)
// =====================================================================
async function handleMessage(msg: NonNullable<TgUpdate['message']>) {
  const text = (msg.text ?? '').trim();
  if (!text) return;

  // Команды
  if (text.startsWith('/')) {
    return await handleCommand(text);
  }

  // Свободный текст: либо правка драфта коммента, либо правка поста
  const dialogId = await getAwaitingCorrectionId();
  if (dialogId) return await handleDialogCorrection(dialogId, text);

  const peId = await getAwaitingPostEditId();
  if (peId) return await handlePostEditCorrection(peId, text);

  const drId = await getAwaitingDraftId();
  if (drId) return await handleDraftCorrection(drId, text);

  // Outreach: правка комментария для чужого треда
  const ocId = await getAwaitingOutreachId();
  if (ocId) return await handleOutreachCorrection(ocId, text);

  // Никто не ждёт текст — это просто свободное сообщение
  // Тихо игнорируем, чтобы не спамить
}

async function handleDraftCorrection(draftId: string, userText: string) {
  const d = await getDraft(draftId);
  if (!d || d.status !== 'awaiting_correction') {
    await setAwaitingDraftId(null);
    return;
  }
  d.corrections_ru.push(userText);
  let newText: string;
  try {
    // Поле text_en оставлено только для совместимости; внутри русский текст.
    // принимает original / current / corrections
    const original = d.text_en; // первая версия «Ильякова Тредс»
    // current = последний вариант — после очередной правки он становится новым
    newText = await reviseDraftPost(original, d.text_en, d.corrections_ru);
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ LLM упал при правке драфта:</b>\n<pre>${escape(String(e).slice(0, 400))}</pre>`);
    return;
  }
  d.text_en = newText;
  d.status = 'awaiting_approval';
  await saveDraft(d);
  await setAwaitingDraftId(null);
  const { text, keyboard } = formatDraft(d);
  if (d.telegram_message_id) {
    await editMessageText(d.telegram_message_id, text, { inlineKeyboard: keyboard });
  } else {
    const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
    d.telegram_message_id = sent.message_id;
    await saveDraft(d);
  }
}

async function handleCommand(text: string) {
  const [cmd, ...args] = text.split(/\s+/);

  if (cmd === '/help' || cmd === '/start') {
    await sendTelegram(
      `<b>Команды «Ильякова Тредс»:</b>\n\n` +
        `/preview — показать ближайшие 3 драфта из очереди\n` +
        `/edit — редактировать последний опубликованный пост\n` +
        `/generate [subscribe|discovery|brand] — сгенерить пост\n` +
        `/outreach [тема] — найти чужие треды и предложить комменты с CTA\n` +
        `/analyze — прогнать анализ архива прямо сейчас (не ждать понедельника)\n` +
        `/register &lt;url&gt; — зарегистрировать пост, опубликованный руками\n` +
        `/help — эта справка\n\n` +
        `📷 <b>Просто пришли фото в чат</b> → бот спросит: ` +
        `заменить последний пост, прикрепить к ближайшему драфту или просто сохранить.\n\n` +
        `Бот сам генерит посты, когда очередь пустеет, ` +
        `присылает на одобрение в этот чат.\n` +
        `На комменты бот сам присылает уведомления с черновиком ответа.\n` +
        `Раз в неделю (пн 9:00 Tashkent) — анализ архива комментов и обновление findings.`
    );
    return;
  }

  if (cmd === '/preview' || cmd === '/next3') {
    const items = await listQueue();
    const drafts = items.filter((i) => {
      const status = String(i.frontmatter.status ?? '').toLowerCase();
      return status === '' || status === 'draft';
    });
    await sendTelegram(formatPreview(drafts.slice(0, 3)), { disablePreview: true });
    return;
  }

  if (cmd === '/edit') {
    return await startPostEdit();
  }

  if (cmd === '/generate' || cmd === '/gen') {
    return await startGenerate(args[0]);
  }

  if (cmd === '/analyze') {
    return await runAnalyzeNow();
  }

  if (cmd === '/register') {
    return await registerManualPost(args[0]);
  }

  if (cmd === '/outreach') {
    return await startOutreach(args.join(' ').trim() || null);
  }

  await sendTelegram(`Неизвестная команда: <code>${escape(cmd)}</code>. Напиши /help`);
}

async function registerManualPost(url?: string) {
  if (!url) {
    await sendTelegram(
      '<b>Как использовать:</b>\n' +
        `<code>/register https://www.threads.com/${handleAt()}/post/XXX</code>\n\n` +
        'Бот найдёт этот пост по ссылке, добавит в очередь как posted, ' +
        'и дальше будет следить за комментами под ним.'
    );
    return;
  }
  await sendTelegram(`🔎 Ищу пост <code>${escape(url)}</code>…`);
  try {
    const { findPostByPermalink } = await import('@/lib/threads');
    const post = await findPostByPermalink(url, 50);
    if (!post) {
      await sendTelegram(
        '⚠️ Не нашла пост в последних 50 публикациях аккаунта. ' +
          `Проверь что ссылка правильная и пост действительно опубликован под ${handleAt()}.`
      );
      return;
    }

    // Создаём файл в queue со статусом posted
    const date = post.timestamp ? post.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const slug = (post.text ?? 'manual')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .slice(0, 5)
      .join('-')
      .slice(0, 50) || 'manual';
    const filename = `${date}-manual-${slug}.md`;
    const path = `queue/${filename}`;

    const publishedAt = post.timestamp
      ? post.timestamp.replace('T', ' ').slice(0, 16)
      : new Date().toISOString().replace('T', ' ').slice(0, 16);

    const frontmatter = [
      '---',
      `status: posted`,
      `platform: threads`,
      `created: ${date}`,
      `pillar: manual`,
      `published_at: '${publishedAt}'`,
      `threads_post_id: '${post.id}'`,
      `threads_url: '${post.permalink}'`,
      `notes: "Опубликовано вручную через приложение Threads. Зарегистрировано через /register, чтобы бот следил за комментами."`,
      '---',
    ].join('\n');
    const body = `\n\n# Manual post\n\n## Пост 1\n\n${post.text ?? '(no text)'}\n`;
    await putFile(path, frontmatter + body, `register manual post: ${filename}`);

    await sendTelegram(
      `✅ <b>Зарегистрирован.</b>\n` +
        `Файл: <code>${escape(filename)}</code>\n` +
        `Threads ID: <code>${escape(post.id)}</code>\n` +
        `<a href="${escape(post.permalink)}">открыть в Threads</a>\n\n` +
        `Watcher начнёт следить за комментами в течение 5 минут. ` +
        `Архив комментов будет копиться в analytics/threads-report.md, ` +
        `включится в weekly-analysis.`
    );
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ Ошибка регистрации:</b>\n<pre>${escape(String(e).slice(0, 500))}</pre>`);
  }
}

// Конвертирует markdown от LLM в Telegram HTML (parse_mode=HTML).
// Копия логики из cron/weekly-analysis — чтобы /analyze работал без самовызова по сети.
function mdToTgHtml(md: string): string {
  let s = escape(md);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>');
  s = s.replace(/^###\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^##\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^#\s+(.+)$/gm, '<b>$1</b>');
  return s;
}

async function runAnalyzeNow() {
  await sendTelegram('🔍 Запускаю анализ архива комментов…');
  try {
    // Вызываем анализ НАПРЯМУЮ в этом же процессе, а не через self-fetch на
    // защищённый VERCEL_URL (раньше падало из-за Deployment Protection / таймаута).
    const metrics = await collectWeeklyMetrics(7);
    const report = await analyzeArchive(metrics);

    const header =
      `📊 <b>Weekly ${handleAt()}</b>\n` +
      `Архив: ${(report.meta.archive_size_chars / 1000).toFixed(1)}k символов | ` +
      `постов за неделю: ${report.meta.metrics_count} | ` +
      `тем найдено: ${report.meta.total_themes_found}\n` +
      `<b>✅ Confirmed (≥${CONFIRMED_THRESHOLD} разных юзеров): ${report.confirmed_findings.length}</b>\n` +
      `<i>Weak signals: ${report.weak_signals.length}</i>\n\n`;
    await sendTelegram(header + mdToTgHtml(report.summary_md), { disablePreview: true });

    // Confirmed findings отдельным сообщением с цитатами
    if (report.confirmed_findings.length > 0) {
      const findingsBlock = report.confirmed_findings
        .filter((f) => f.module !== 'other')
        .map((f) => {
          const quotes = f.example_quotes.slice(0, 2).map((q) => `<i>«${escape(q)}»</i>`).join(' · ');
          return (
            `<b>[${f.module}]</b> ${escape(f.text)}\n` +
            `n=${f.evidence_count}: ${escape(f.evidence_users.slice(0, 6).join(', '))}\n` +
            `${quotes}`
          );
        })
        .join('\n\n');
      if (findingsBlock) {
        await sendTelegram(`<b>💡 Confirmed findings:</b>\n\n${findingsBlock}`, { disablePreview: true });
      }
    }

    // Записать confirmed в castdev_findings.md + weak signals отдельно
    const { added } = await appendConfirmedFindings(report);
    await writeWeakSignals(report);

    if (added > 0) {
      await sendTelegram(
        `💾 В <code>queue/castdev_findings.md</code> добавлено: <b>${added}</b> findings. Ильякова Тредс учтёт их в следующих discovery-постах.`
      );
    }
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ Анализ упал:</b>\n<pre>${escape(String(e?.message ?? e).slice(0, 600))}</pre>`);
  }
}

async function startGenerate(goalArg?: string) {
  const goal =
    goalArg === 'subscribe' || goalArg === 'discovery' || goalArg === 'brand'
      ? goalArg
      : undefined;
  await sendTelegram(`🤖 Ильякова Тредс пишет драфт${goal ? ` (тип: ${goal})` : ''}…`);
  try {
    const gen = await generatePost(goal);
    const { genDraftId } = await import('@/lib/post-draft');
    const draft: PostDraft = {
      id: genDraftId(),
      goal: gen.goal,
      castdev_module: gen.castdev_module,
      text_en: gen.text_en,
      suggested_filename: gen.suggested_filename,
      rationale: gen.rationale,
      corrections_ru: [],
      status: 'awaiting_approval',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await saveDraft(draft);
    const { text, keyboard } = formatDraft(draft);
    const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
    draft.telegram_message_id = sent.message_id;
    await saveDraft(draft);
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ Не получилось сгенерить:</b>\n<pre>${escape(String(e).slice(0, 500))}</pre>`);
  }
}

async function handleDraftCallback(
  action: string,
  draftId: string,
  cb: NonNullable<TgUpdate['callback_query']>
) {
  const d = draftId ? await getDraft(draftId) : null;
  if (!d) {
    await answerCallbackQuery(cb.id, 'Драфт не найден или уже закрыт');
    return;
  }

  if (action === 'dr_cancel' || action === 'dr_reject') {
    d.status = 'rejected';
    await saveDraft(d);
    if ((await getAwaitingDraftId()) === d.id) await setAwaitingDraftId(null);
    await answerCallbackQuery(cb.id, 'Отклонила');
    const { text, keyboard } = formatDraft(d);
    if (d.telegram_message_id) {
      await editMessageText(d.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  if (action === 'dr_edit') {
    d.status = 'awaiting_correction';
    await saveDraft(d);
    await setAwaitingDraftId(d.id);
    await answerCallbackQuery(cb.id, 'Жду правку текстом');
    const { text, keyboard } = formatDraft(d);
    if (d.telegram_message_id) {
      await editMessageText(d.telegram_message_id, text, { inlineKeyboard: keyboard });
    }
    return;
  }

  if (action === 'dr_approve') {
    await answerCallbackQuery(cb.id, 'Кладу в очередь…');
    try {
      // Создаём файл в queue/ со статусом draft — autopost cron его подхватит
      const filename = d.suggested_filename;
      const path = `queue/${filename}`;
      const today = new Date().toISOString().slice(0, 10);
      const fm = [
        '---',
        `created: ${today}`,
        `goal: ${d.goal}`,
        ...(d.castdev_module ? [`castdev_module: ${d.castdev_module}`] : []),
        `pillar: ilyakova_generated`,
        `status: draft`,
        '---',
      ].join('\n');
      const body = `\n\n## Пост 1\n\n${d.text_en}\n`;
      await putFile(path, fm + body, `ilyakova draft: ${filename}`);

      d.status = 'approved';
      await saveDraft(d);
      if ((await getAwaitingDraftId()) === d.id) await setAwaitingDraftId(null);

      const { text, keyboard } = formatDraft(d);
      if (d.telegram_message_id) {
        await editMessageText(d.telegram_message_id, text, { inlineKeyboard: keyboard });
      }
    } catch (e: any) {
      await sendTelegram(`<b>⚠️ Не смогла положить в очередь:</b>\n<pre>${escape(String(e).slice(0, 500))}</pre>`);
    }
    return;
  }

  await answerCallbackQuery(cb.id, `Неизвестное действие: ${action}`);
}

async function startPostEdit() {
  // Берём последний пост со статусом posted в очереди
  const items = await listQueue();
  const posted = items.filter(
    (i) =>
      String(i.frontmatter.status ?? '').toLowerCase() === 'posted' &&
      i.frontmatter.threads_post_id
  );
  if (posted.length === 0) {
    await sendTelegram('🤷 В очереди нет опубликованных постов.');
    return;
  }

  // Сортируем по published_at (или по имени файла — fallback)
  posted.sort((a, b) => {
    const ta = String(a.frontmatter.published_at ?? a.path);
    const tb = String(b.frontmatter.published_at ?? b.path);
    return tb.localeCompare(ta);
  });

  const last = posted[0];
  const postId = String(last.frontmatter.threads_post_id);
  const publishedAt = String(last.frontmatter.published_at ?? '');
  const url = String(last.frontmatter.threads_url ?? '');

  // Предупреждение если пост старше 24 часов — Threads API скорее всего откажет удалять
  if (publishedAt) {
    const d = new Date(publishedAt.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(d.getTime())) {
      const hoursAgo = (Date.now() - d.getTime()) / 3_600_000;
      if (hoursAgo > 24) {
        await sendTelegram(
          `⚠️ <b>Последний пост опубликован ${Math.floor(hoursAgo)} ч назад.</b>\n` +
            `Threads API позволяет удалять только посты младше 24 часов. ` +
            `Если удаление не сработает, новый пост всё равно опубликую, ` +
            `но старый придётся удалять вручную в приложении.`
        );
      }
    }
  }

  const pe: PostEdit = {
    id: genPostEditId(),
    queue_path: last.path,
    threads_post_id: postId,
    threads_url: url,
    original_text_en: last.posts[0] ?? '',
    current_text_en: last.posts[0] ?? '',
    corrections_ru: [],
    status: 'awaiting_correction',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await savePostEdit(pe);
  await setAwaitingPostEditId(pe.id);

  const { text, keyboard } = formatPostEdit(pe);
  const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
  pe.telegram_message_id = sent.message_id;
  await savePostEdit(pe);
}

async function handleDialogCorrection(dialogId: string, userText: string) {
  const dialog = await getDialog(dialogId);
  if (!dialog || dialog.status !== 'awaiting_correction') {
    await setAwaitingCorrectionId(null);
    return;
  }

  let revised: string;
  try {
    revised = await reviseDraft(
      {
        postText: dialog.post_text,
        replyText: dialog.reply_text_en,
        replyUsername: dialog.reply_username,
      },
      dialog.draft_ru,
      userText
    );
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ LLM упал при правке:</b>\n<pre>${String(e).slice(0, 400)}</pre>`);
    return;
  }

  dialog.draft_ru = revised;
  dialog.status = 'awaiting_approval';
  await saveDialog(dialog);
  await setAwaitingCorrectionId(null);

  const { text: newText, keyboard } = formatDialog(dialog);
  if (dialog.telegram_message_id) {
    await editMessageText(dialog.telegram_message_id, newText, { inlineKeyboard: keyboard });
  } else {
    const sent = await sendTelegram(newText, { disablePreview: true, inlineKeyboard: keyboard });
    dialog.telegram_message_id = sent.message_id;
    await saveDialog(dialog);
  }
}

async function handlePostEditCorrection(peId: string, userText: string) {
  const pe = await getPostEdit(peId);
  if (!pe || pe.status !== 'awaiting_correction') {
    await setAwaitingPostEditId(null);
    return;
  }

  // Накапливаем правки и просим LLM переписать
  pe.corrections_ru.push(userText);

  let newEn: string;
  try {
    newEn = await editPublishedPost({
      originalEn: pe.original_text_en,
      currentEn: pe.current_text_en,
      correctionsRu: pe.corrections_ru,
    });
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ LLM упал при правке поста:</b>\n<pre>${String(e).slice(0, 400)}</pre>`);
    return;
  }

  pe.current_text_en = newEn;
  pe.status = 'awaiting_approval';
  await savePostEdit(pe);
  await setAwaitingPostEditId(null);

  const { text, keyboard } = formatPostEdit(pe);
  if (pe.telegram_message_id) {
    await editMessageText(pe.telegram_message_id, text, { inlineKeyboard: keyboard });
  } else {
    const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
    pe.telegram_message_id = sent.message_id;
    await savePostEdit(pe);
  }
}


// =====================================================================
// OUTREACH — комментирование чужих тредов
// =====================================================================

// Создание задания на outreach — воркер подхватит из Redis
async function startOutreach(topic: string | null) {
  const job: OutreachJob = {
    id: genOutreachJobId(),
    topic,
    status: 'pending',
    items_found: 0,
    items_approved: 0,
    items_published: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await saveOutreachJob(job);

  await sendTelegram(
    `<b>Ищу треды для комментирования...</b>\n\n` +
    `Тема: ${topic ? escape(topic) : 'дефолтный набор запросов'}\n` +
    `Результаты пришлю по готовности (1-3 мин).`
  );
}

// Обработка кнопок outreach-карточек
async function handleOutreachCallback(
  action: string,
  itemId: string,
  cb: NonNullable<TgUpdate['callback_query']>
) {
  const item = itemId ? await getOutreachItem(itemId) : null;
  if (!item) {
    await answerCallbackQuery(cb.id, 'Outreach-элемент не найден или уже закрыт');
    return;
  }

  // ✅ Опубликовать — НЕ через API (он не отвечает на чужие посты),
  // а ставим статус 'approved' → локальный воркер опубликует через браузер (Chromium).
  if (action === 'oc_approve') {
    if (!item.comment_en.trim()) {
      await answerCallbackQuery(cb.id, 'Комментарий пустой — нечего публиковать');
      return;
    }
    item.status = 'approved';
    await saveOutreachItem(item);
    await answerCallbackQuery(cb.id, 'Принято — публикую через браузер...');

    if (item.telegram_message_id) {
      await editMessageText(
        item.telegram_message_id,
        `<b>Outreach: одобрено, публикую…</b>\n` +
        `Автор: <b>@${escape(item.thread_author)}</b>\n` +
        `<a href="${escape(item.thread_url)}">тред</a>\n\n` +
        `<blockquote>${escape(item.comment_en)}</blockquote>\n` +
        `<i>Воркер опубликует в браузере, пришлёт подтверждение.</i>`,
        { inlineKeyboard: [] }
      );
    }
    return;
  }

  // ✍️ Поправить
  if (action === 'oc_edit') {
    item.status = 'awaiting_correction';
    await saveOutreachItem(item);
    await setAwaitingOutreachId(item.id);

    await answerCallbackQuery(cb.id, 'Жду правку текстом');
    if (item.telegram_message_id) {
      const postRu = item.thread_text_ru?.trim() || item.thread_text;
      const postPreview = postRu.length > 300 ? postRu.slice(0, 300) + '...' : postRu;

      await editMessageText(
        item.telegram_message_id,
        `<b>Outreach: правка комментария</b>\n` +
        `Автор: <b>@${escape(item.thread_author)}</b>\n\n` +
        `<b>Их пост:</b>\n<blockquote>${escape(postPreview)}</blockquote>\n\n` +
        `<b>Текущий ответ:</b>\n<blockquote>${escape(item.comment_ru)}</blockquote>\n\n` +
        `✍️ <i>Напиши правку текстом (например: «короче», «без упоминания бренда», «более тёплый тон»).</i>`,
        { inlineKeyboard: [[{ text: '❌ Отмена', callback_data: `oc_skip:${item.id}` }]] }
      );
    }
    return;
  }

  // ⏭ Пропустить
  if (action === 'oc_skip') {
    item.status = 'skipped';
    await saveOutreachItem(item);
    if ((await getAwaitingOutreachId()) === item.id) await setAwaitingOutreachId(null);

    // Помечаем тред как обработанный (чтобы не предлагать повторно)
    const shortcodeMatch = item.thread_url.match(/\/post\/([A-Za-z0-9_-]+)/);
    if (shortcodeMatch) await markThreadSeen(shortcodeMatch[1]);

    await answerCallbackQuery(cb.id, 'Пропустила');
    if (item.telegram_message_id) {
      await editMessageText(
        item.telegram_message_id,
        `<b>Outreach: пропущено</b>\n` +
        `Автор: @${escape(item.thread_author)}\n` +
        `<a href="${escape(item.thread_url)}">тред</a>\n\n` +
        `⏭ <i>Не будет предлагаться снова.</i>`,
        { inlineKeyboard: [] }
      );
    }
    return;
  }

  await answerCallbackQuery(cb.id, `Неизвестное действие: ${action}`);
}

// Обработка текстовой правки outreach-комментария
async function handleOutreachCorrection(itemId: string, userText: string) {
  const item = await getOutreachItem(itemId);
  if (!item || item.status !== 'awaiting_correction') {
    await setAwaitingOutreachId(null);
    return;
  }

  item.corrections_ru.push(userText);

  try {
    // Вызываем LLM для ревизии через OpenRouter (тот же паттерн что reviseDraftPost)
    const { reviseOutreachComment } = await import('@/lib/outreach-revise');
    const revised = await reviseOutreachComment(
      item.thread_text,
      item.comment_en,
      userText
    );
    item.comment_en = revised.comment_en;
    item.comment_ru = revised.comment_ru;
  } catch (e: any) {
    await sendTelegram(`<b>Outreach: LLM упал при правке:</b>\n<pre>${escape(String(e).slice(0, 400))}</pre>`);
    return;
  }

  item.status = 'awaiting_approval';
  await saveOutreachItem(item);
  await setAwaitingOutreachId(null);

  // Обновляем карточку: и исходный пост, и наш ответ показываем по-русски.
  const postRu = item.thread_text_ru?.trim() || item.thread_text;
  const postPreview = postRu.length > 300 ? postRu.slice(0, 300) + '...' : postRu;

  const corrections = item.corrections_ru.map((c, i) => `${i + 1}. ${escape(c)}`).join('\n');
  const text =
    `<b>Outreach: найден тред</b>\n` +
    `Автор: <b>@${escape(item.thread_author)}</b>\n` +
    `<a href="${escape(item.thread_url)}">открыть в Threads</a>\n\n` +
    `<b>Их пост:</b>\n<blockquote>${escape(postPreview)}</blockquote>\n\n` +
    `<b>Наш ответ:</b>\n<blockquote>${escape(item.comment_ru)}</blockquote>\n\n` +
    `<b>Правки:</b>\n${corrections}`;

  const keyboard = [
    [
      { text: '✅ Опубликовать', callback_data: `oc_approve:${item.id}` },
      { text: '✍️ Поправить', callback_data: `oc_edit:${item.id}` },
    ],
    [{ text: '⏭ Пропустить', callback_data: `oc_skip:${item.id}` }],
  ];

  if (item.telegram_message_id) {
    await editMessageText(item.telegram_message_id, text, { inlineKeyboard: keyboard });
  } else {
    const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
    item.telegram_message_id = sent.message_id;
    await saveOutreachItem(item);
  }
}

// =====================================================================
// PHOTO upload — пользователь прислал фото/документ-изображение
// =====================================================================
async function handlePhoto(msg: NonNullable<TgUpdate['message']>) {
  // Из массива photo берём самый большой вариант (последний)
  let fileId: string | undefined;
  if (msg.photo && msg.photo.length > 0) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document && (msg.document.mime_type ?? '').startsWith('image/')) {
    fileId = msg.document.file_id;
  }
  if (!fileId) return;

  await sendTelegram('🖼 Принимаю фото, заливаю в репо…');
  let uploaded: { public_path: string; repo_path: string };
  try {
    const id = genPhotoPendingId();
    uploaded = await downloadTelegramPhotoToRepo(fileId, id);
    const pending: PhotoPending = {
      id,
      public_path: uploaded.public_path,
      repo_path: uploaded.repo_path,
      created_at: new Date().toISOString(),
    };
    await savePhotoPending(pending);

    // Информация о последнем опубликованном посте (для кнопки "переопубликовать")
    const items = await listQueue();
    const posted = items
      .filter(
        (i) =>
          String(i.frontmatter.status ?? '').toLowerCase() === 'posted' &&
          i.frontmatter.threads_post_id
      )
      .sort((a, b) => {
        const ta = String(a.frontmatter.published_at ?? a.path);
        const tb = String(b.frontmatter.published_at ?? b.path);
        return tb.localeCompare(ta);
      });
    const last = posted[0];
    const lastFilename = last ? last.path.split('/').pop() : null;

    const text =
      `🖼 <b>Фото загружено:</b> <code>${escape(uploaded.public_path)}</code>\n\n` +
      `Что делать?\n\n` +
      (lastFilename
        ? `1. <b>Переопубликовать последний пост</b> с этим фото\n   <code>${escape(lastFilename)}</code>\n\n`
        : '') +
      `2. Привязать к ближайшему черновику в очереди\n` +
      `3. Просто сохранить (использую позже вручную)`;

    const buttons = [];
    if (lastFilename) {
      buttons.push([
        { text: '♻️ Заменить последний пост', callback_data: `ph_replace_last:${pending.id}` },
      ]);
    }
    buttons.push([
      { text: '📋 К ближайшему драфту', callback_data: `ph_attach_next:${pending.id}` },
    ]);
    buttons.push([{ text: '❌ Отмена', callback_data: `ph_cancel:${pending.id}` }]);

    const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: buttons });
    pending.telegram_message_id = sent.message_id;
    await savePhotoPending(pending);
  } catch (e: any) {
    await sendTelegram(`<b>⚠️ Не смогла залить фото:</b>\n<pre>${escape(String(e).slice(0, 400))}</pre>`);
  }
}

async function handlePhotoCallback(
  action: string,
  ppId: string,
  cb: NonNullable<TgUpdate['callback_query']>
) {
  const pp = ppId ? await getPhotoPending(ppId) : null;
  if (!pp) {
    await answerCallbackQuery(cb.id, 'Фото не найдено или истекло');
    return;
  }

  if (action === 'ph_cancel') {
    await deletePhotoPending(pp.id);
    await answerCallbackQuery(cb.id, 'Отменила');
    if (pp.telegram_message_id) {
      await editMessageText(
        pp.telegram_message_id,
        `🖼 Фото <code>${escape(pp.public_path)}</code> осталось в репо, но никуда не привязано.`,
        { inlineKeyboard: [] }
      );
    }
    return;
  }

  if (action === 'ph_replace_last') {
    await answerCallbackQuery(cb.id, 'Удаляю старый, публикую с фото…');
    try {
      const items = await listQueue();
      const posted = items
        .filter(
          (i) =>
            String(i.frontmatter.status ?? '').toLowerCase() === 'posted' &&
            i.frontmatter.threads_post_id
        )
        .sort((a, b) => {
          const ta = String(a.frontmatter.published_at ?? a.path);
          const tb = String(b.frontmatter.published_at ?? b.path);
          return tb.localeCompare(ta);
        });
      const last = posted[0];
      if (!last) {
        await sendTelegram('Не нашла опубликованного поста для замены.');
        return;
      }

      const oldPostId = String(last.frontmatter.threads_post_id);
      const postText = last.posts[0] ?? '';

      // Делаем абсолютный URL фото (Threads API скачивает по нему)
      const base = process.env.PUBLIC_MEDIA_BASE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
      if (!base) {
        await sendTelegram('⚠️ Нет публичного URL для медиа (нет VERCEL_URL/PUBLIC_MEDIA_BASE_URL).');
        return;
      }
      const imageUrl = `${base.replace(/\/$/, '')}${pp.public_path}`;

      // Удаляем старый
      try {
        await deletePost(oldPostId);
      } catch (delErr: any) {
        await sendTelegram(
          `⚠️ Старый пост удалить не вышло (видимо >24ч):\n<pre>${escape(String(delErr).slice(0, 300))}</pre>\nПубликую новый — старый удали вручную.`
        );
      }

      // Публикуем с фото
      const published = await publishImage(postText, imageUrl);

      // Обновляем frontmatter файла
      const newFm = {
        ...last.frontmatter,
        status: 'posted',
        threads_post_id: published.id,
        threads_url: published.permalink,
        published_at: new Date().toISOString().replace('T', ' ').slice(0, 16),
        media: [{ type: 'image', path: pp.public_path, alt: 'cover' }],
      };
      const matter = await import('gray-matter');
      const parsed = matter.default(last.rawContent);
      const newContent = matter.default.stringify(parsed.content, newFm);
      await putFile(last.path, newContent, `republish with media: ${last.path.split('/').pop()}`, last.sha);

      await deletePhotoPending(pp.id);
      if (pp.telegram_message_id) {
        await editMessageText(
          pp.telegram_message_id,
          `✅ <b>Переопубликовано с фото.</b>\n` +
            `<a href="${published.permalink}">открыть в Threads</a>\n` +
            `Фото: <code>${escape(pp.public_path)}</code>`,
          { inlineKeyboard: [] }
        );
      }
    } catch (e: any) {
      await sendTelegram(`<b>⚠️ Ошибка при переподаче:</b>\n<pre>${escape(String(e).slice(0, 600))}</pre>`);
    }
    return;
  }

  if (action === 'ph_attach_next') {
    await answerCallbackQuery(cb.id, 'Привязываю к ближайшему черновику…');
    try {
      const items = await listQueue();
      const drafts = items.filter((i) => {
        const status = String(i.frontmatter.status ?? '').toLowerCase();
        return status === '' || status === 'draft';
      });
      const next = drafts[0];
      if (!next) {
        await sendTelegram('В очереди нет черновиков.');
        return;
      }

      const existingMedia = Array.isArray(next.frontmatter.media) ? next.frontmatter.media : [];
      const newFm = {
        ...next.frontmatter,
        media: [...existingMedia, { type: 'image', path: pp.public_path, alt: 'cover' }],
      };
      const matter = await import('gray-matter');
      const parsed = matter.default(next.rawContent);
      const newContent = matter.default.stringify(parsed.content, newFm);
      await putFile(next.path, newContent, `attach media: ${next.path.split('/').pop()}`, next.sha);

      await deletePhotoPending(pp.id);
      if (pp.telegram_message_id) {
        await editMessageText(
          pp.telegram_message_id,
          `✅ Фото привязано к <code>${escape(next.path.split('/').pop() ?? '')}</code>`,
          { inlineKeyboard: [] }
        );
      }
    } catch (e: any) {
      await sendTelegram(`<b>⚠️ Ошибка:</b>\n<pre>${escape(String(e).slice(0, 400))}</pre>`);
    }
    return;
  }

  await answerCallbackQuery(cb.id, `Неизвестное действие: ${action}`);
}
