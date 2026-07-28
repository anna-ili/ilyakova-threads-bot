// Форматирование Telegram-сообщений для диалога с «Ильякова Тредс».
import type { Dialog } from './dialog';
import type { PostEdit } from './post-edit';
import type { PostDraft } from './post-draft';
import type { QueueItem } from './queue';
import type { InlineKeyboard } from './telegram';

// HTML-экранирование для Telegram (чтобы < > & не сломали parse_mode=HTML)
export function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Собирает текст сообщения для одного диалога — комментарий + черновик ответа
export function formatDialog(d: Dialog): { text: string; keyboard: InlineKeyboard } {
  if (d.status === 'done' && d.skip_reason) {
    return {
      text:
        `<b>Комментарий пропущен</b>\n` +
        `Под постом: <code>${escape(d.post_filename)}</code>\n` +
        `От <b>@${escape(d.reply_username)}</b>:\n\n${escape(d.reply_text_en)}\n\n` +
        `Причина skip: ${escape(d.skip_reason)}`,
      keyboard: [],
    };
  }

  const header =
    `<b>Новый комментарий в Threads</b>\n` +
    `Под постом: <code>${escape(d.post_filename)}</code>\n` +
    `От <b>@${escape(d.reply_username)}</b>\n` +
    `<a href="${escape(d.reply_permalink)}">открыть в Threads</a>`;

  const originalBlock =
    `\n\n<b>Комментарий:</b>\n<blockquote>${escape(d.reply_text_en)}</blockquote>`;

  const meaningBlock = d.comment_ru && d.comment_ru.trim() !== d.reply_text_en.trim()
    ? `<b>Смысл:</b>\n<blockquote>${escape(d.comment_ru)}</blockquote>`
    : '';

  if (d.status === 'awaiting_approval') {
    const draftBlock = `<b>Предлагаю ответить:</b>\n<blockquote>${escape(d.draft_ru)}</blockquote>`;
    const text = [header, originalBlock, meaningBlock, draftBlock].filter(Boolean).join('\n\n');
    return {
      text,
      keyboard: [
        [
          { text: '✅ Публиковать', callback_data: `approve:${d.id}` },
          { text: '✍️ Поправить', callback_data: `edit:${d.id}` },
        ],
        [{ text: '⏭ Пропустить', callback_data: `skip:${d.id}` }],
      ],
    };
  }

  if (d.status === 'awaiting_correction') {
    const text =
      [header, originalBlock, meaningBlock].filter(Boolean).join('\n\n') +
      `\n\n<b>Черновик, который правим:</b>\n<blockquote>${escape(d.draft_ru)}</blockquote>` +
      `\n\n✍️ <i>Напиши ответом в чат, что поправить (например: «короче», «без упоминания сайта/бренда», «более тёплый тон»).</i>`;
    return {
      text,
      keyboard: [[{ text: '❌ Отмена', callback_data: `cancel:${d.id}` }]],
    };
  }

  if (d.status === 'scheduled_publish') {
    const publishAt = d.publish_at ? new Date(d.publish_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
    const text =
      [header, originalBlock, meaningBlock].filter(Boolean).join('\n\n') +
      `\n\n<b>Одобренный черновик:</b>\n<blockquote>${escape(d.draft_ru)}</blockquote>` +
      `\n\n⏱ <i>Публикация запланирована на ${escape(publishAt)} (МСК)</i>`;
    return {
      text,
      keyboard: [[{ text: '❌ Отменить публикацию', callback_data: `cancel:${d.id}` }]],
    };
  }

  // done (published)
  const text =
    [header, originalBlock, meaningBlock].filter(Boolean).join('\n\n') +
    `\n\n✅ <b>Опубликовано:</b>\n<blockquote>${escape(d.reply_text_en_final ?? d.draft_ru)}</blockquote>`;
  return { text, keyboard: [] };
}

// =====================================================================
// Форматирование PostEdit (редактирование последнего опубликованного поста)
// =====================================================================
export function formatPostEdit(p: PostEdit): { text: string; keyboard: InlineKeyboard } {
  const header =
    `<b>Редактирование поста</b>\n` +
    `<a href="${escape(p.threads_url)}">открыть в Threads</a>\n` +
    `Файл: <code>${escape(p.queue_path.split('/').pop() ?? p.queue_path)}</code>`;

  const originalBlock =
    `\n\n<b>Оригинал:</b>\n<blockquote>${escape(p.original_text_en)}</blockquote>`;

  if (p.status === 'awaiting_correction') {
    const hint = p.corrections_ru.length === 0
      ? '✍️ <i>Напиши правку русским текстом — что изменить (например: «сделай короче», «убери последнюю фразу», «добавь уточняющий вопрос»).</i>'
      : '✍️ <i>Напиши следующую правку, или нажми «Готово» если устраивает.</i>';

    const currentBlock = p.current_text_en !== p.original_text_en
      ? `\n\n<b>Текущий вариант:</b>\n<blockquote>${escape(p.current_text_en)}</blockquote>`
      : '';

    return {
      text: header + originalBlock + currentBlock + '\n\n' + hint,
      keyboard: [[{ text: '❌ Отмена', callback_data: `pe_cancel:${p.id}` }]],
    };
  }

  if (p.status === 'awaiting_approval') {
    const corr = p.corrections_ru.map((c, i) => `${i + 1}. ${escape(c)}`).join('\n');
    return {
      text:
        header +
        originalBlock +
        `\n\n<b>Новый вариант:</b>\n<blockquote>${escape(p.current_text_en)}</blockquote>` +
        `\n\n<b>Учтены правки:</b>\n${corr}` +
        `\n\n⚠️ <i>Старый пост будет удалён, новый опубликован. Лайки/комменты не переносятся.</i>`,
      keyboard: [
        [
          { text: '✅ Опубликовать', callback_data: `pe_publish:${p.id}` },
          { text: '✍️ Ещё правка', callback_data: `pe_more:${p.id}` },
        ],
        [{ text: '❌ Отмена', callback_data: `pe_cancel:${p.id}` }],
      ],
    };
  }

  // done
  return {
    text: header + `\n\n✅ <b>Новый пост опубликован.</b>\n<blockquote>${escape(p.current_text_en)}</blockquote>`,
    keyboard: [],
  };
}

// =====================================================================
// Превью ближайших драфтов из очереди (/preview)
// =====================================================================
export function formatPreview(items: QueueItem[]): string {
  if (items.length === 0) return '📭 Очередь пуста.';

  const lines: string[] = [`<b>Ближайшие ${items.length} драфтов в очереди:</b>\n`];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const filename = it.path.split('/').pop() ?? it.path;
    const goal = it.frontmatter.goal ? ` <i>[${it.frontmatter.goal}]</i>` : '';
    const pillar = it.frontmatter.pillar ? ` <i>(${it.frontmatter.pillar})</i>` : '';
    const mediaCount = Array.isArray(it.frontmatter.media) ? it.frontmatter.media.length : 0;
    const mediaTag = mediaCount > 0 ? ` 🖼×${mediaCount}` : '';

    lines.push(`<b>${i + 1}. <code>${escape(filename)}</code>${goal}${pillar}${mediaTag}</b>`);

    const firstPost = it.posts[0] ?? '';
    const preview = firstPost.length > 280 ? firstPost.slice(0, 280) + '…' : firstPost;
    lines.push(`<blockquote>${escape(preview)}</blockquote>`);

    if (it.posts.length > 1) {
      lines.push(`<i>+ ещё ${it.posts.length - 1} пост(а) в треде</i>`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// =====================================================================
// Авто-сгенерированный драфт от «Ильякова Тредс» (ждёт одобрения)
// =====================================================================
export function formatDraft(d: PostDraft): { text: string; keyboard: InlineKeyboard } {
  const goalBadge = `<b>[${d.goal}]</b>` + (d.castdev_module ? ` <i>${escape(d.castdev_module)}</i>` : '');
  const header = `🤖 <b>Ильякова Тредс сгенерировал пост</b> ${goalBadge}\n<i>${escape(d.rationale)}</i>`;

  if (d.status === 'awaiting_correction') {
    return {
      text:
        header +
        `\n\n<b>Текущий вариант:</b>\n<blockquote>${escape(d.text_en)}</blockquote>` +
        (d.corrections_ru.length > 0
          ? `\n\n<b>Уже применили правки:</b>\n${d.corrections_ru.map((c, i) => `${i + 1}. ${escape(c)}`).join('\n')}`
          : '') +
        `\n\n✍️ <i>Напиши следующую правку русским текстом, или нажми «Отмена».</i>`,
      keyboard: [[{ text: '❌ Отмена', callback_data: `dr_cancel:${d.id}` }]],
    };
  }

  if (d.status === 'awaiting_approval') {
    return {
      text:
        header +
        `\n\n<b>Текст:</b>\n<blockquote>${escape(d.text_en)}</blockquote>` +
        (d.corrections_ru.length > 0
          ? `\n\n<b>Применены правки:</b>\n${d.corrections_ru.map((c, i) => `${i + 1}. ${escape(c)}`).join('\n')}`
          : '') +
        `\n\n<b>Файл:</b> <code>${escape(d.suggested_filename)}</code>`,
      keyboard: [
        [
          { text: '✅ Одобрить', callback_data: `dr_approve:${d.id}` },
          { text: '✍️ Поправить', callback_data: `dr_edit:${d.id}` },
        ],
        [{ text: '❌ Отклонить', callback_data: `dr_reject:${d.id}` }],
      ],
    };
  }

  // approved / rejected
  const status = d.status === 'approved' ? '✅ Одобрено и поставлено в очередь' : '❌ Отклонено';
  return {
    text: header + `\n\n<blockquote>${escape(d.text_en)}</blockquote>\n\n${status}`,
    keyboard: [],
  };
}
