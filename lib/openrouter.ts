// Генерация через Codex CLI с авторизацией ChatGPT.
import { getBrandVoicePrompt, getPostGenerationPrompt, DraftResult } from './brand';
import { codexChat as chat } from './codex-chat';
import { findHardStyleViolations } from './style-guard';

export interface CommentContext {
  postText: string; // текст поста, под которым коммент
  replyText: string;
  replyUsername: string;
}

// Генерация черновика ответа на комментарий.
export async function generateDraft(ctx: CommentContext): Promise<DraftResult> {
  const userPrompt = `
Пост в Threads:
"""
${ctx.postText}
"""

Всё, что @${ctx.replyUsername} написал в ветке под этим постом:
"""
${ctx.replyText}
"""

Ответь строго в JSON-формате:
{
  "comment_ru": "кратко передай смысл комментария на русском; если он уже русский — сохрани смысл без перевода",
  "recommendation": "publish" или "skip",
  "skip_reason": "коротко почему пропустить, если recommendation = skip",
  "draft_ru": "черновик ответа на русском, если recommendation = publish — по умолчанию с уточняющим вопросом"
}
`.trim();

  const raw = await chat(
    [
      { role: 'system', content: await getBrandVoicePrompt() },
      { role: 'user', content: userPrompt },
    ],
    { jsonMode: true, maxTokens: 600 }
  );

  // Haiku иногда оборачивает JSON в ```json ... ``` — чистим
  let cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1];

  try {
    const parsed = JSON.parse(cleaned) as DraftResult;
    return parsed;
  } catch {
    return {
      comment_ru: '',
      recommendation: 'skip',
      skip_reason: 'LLM parse failure: ' + raw.slice(0, 100),
    };
  }
}

// Переделать черновик по запросу пользователя (например: "покороче", "без упоминания сайта/бренда" и т.д.)
export async function reviseDraft(
  ctx: CommentContext,
  previousDraftRu: string,
  userCorrection: string
): Promise<string> {
  const userPrompt = `
Пост:
"""
${ctx.postText}
"""

Комментарий от @${ctx.replyUsername}:
"""
${ctx.replyText}
"""

Предыдущий черновик ответа (рус):
"""
${previousDraftRu}
"""

Правка от автора канала:
"""
${userCorrection}
"""

Перепиши черновик с учётом правки. Верни ТОЛЬКО новый текст ответа на русском, без пояснений и кавычек.
`.trim();

  const raw = await chat(
    [
      { role: 'system', content: await getBrandVoicePrompt() },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 500 }
  );
  return raw.trim().replace(/^["«'"]|["»'"]$/g, '');
}

// ====================================================================
// Редактирование уже опубликованного поста.
// Пользователь пишет правки на русском («сделай короче», «убери последнюю
// фразу», «добавь уточняющий вопрос») — бот переписывает русский пост.
// ====================================================================

export interface PostEditContext {
  originalEn: string; // оригинал, как был опубликован
  currentEn: string; // текущий вариант (после предыдущих итераций правки)
  correctionsRu: string[]; // история правок (последняя — самая свежая)
}

export async function editPublishedPost(ctx: PostEditContext): Promise<string> {
  const corrections = ctx.correctionsRu.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const userPrompt = `
Это пост бренда в Threads, который УЖЕ опубликован. Его нужно переписать
по правкам автора канала. Сохрани голос бренда (см. system prompt).

Оригинал, как был опубликован:
"""
${ctx.originalEn}
"""

${ctx.currentEn !== ctx.originalEn ? `Текущий вариант после предыдущих правок:\n"""\n${ctx.currentEn}\n"""\n` : ''}
Правки автора (русский, по порядку — последняя самая важная):
${corrections}

Перепиши пост на естественном русском с учётом ВСЕХ правок. Не добавляй
от себя то, чего не было — только то что просили. Верни ТОЛЬКО новый
русский текст поста, без пояснений и без кавычек.
`.trim();

  const raw = await chat(
    [
      { role: 'system', content: await getBrandVoicePrompt() },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 600 }
  );
  return raw.trim().replace(/^["«'"]|["»'"]$/g, '');
}

// =====================================================================
// Правка драфта поста (ещё не опубликованного, авто-сгенерированного ботом)
// =====================================================================
export async function reviseDraftPost(
  originalEn: string,
  currentEn: string,
  correctionsRu: string[]
): Promise<string> {
  const corr = correctionsRu.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const systemPrompt = await getPostGenerationPrompt();
  const userPrompt = `
Это черновик поста для Threads-аккаунта бренда, который написал бот «Ильякова Тредс» и
который ещё НЕ опубликован. Автор канала просит внести правки.

Исходный драфт:
"""
${originalEn}
"""

${currentEn !== originalEn ? `Текущий вариант после предыдущих правок:\n"""\n${currentEn}\n"""\n` : ''}
Правки автора (русский, по порядку — последняя самая важная):
${corr}

Это редактура, а не просьба написать новый большой пост.

- Исправь только то, на что указала Анна.
- Не объясняй тезис подробнее, если она этого не просила.
- Не увеличивай текст; лучше сократи.
- Не превращай замечание в лекцию, методичку или пошаговый разбор.
- Не заменяй один штамп другим.
- Если Анна пишет, что причинно-следственная связь сломана, восстанови одну
  понятную связь внутри исходной мысли, а не добавляй новую теорию.

Верни ТОЛЬКО исправленный русский текст, без пояснений и кавычек.
`.trim();

  const firstPass = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 600 }
  );
  const candidate = firstPass.trim().replace(/^["«'"]|["»'"]$/g, '');

  const reviewPrompt = `
Ты проверяешь не новый пост, а точечную редактуру черновика Анны.

Текст до правки:
"""
${currentEn}
"""

Замечания Анны:
${corr}

Предложенная редактура:
"""
${candidate}
"""

Убери всё, что редактор добавил сверх замечаний: новые объяснения, перечисления,
метафоры, выводы, нейросетевые связки и литературные украшения. Финальная версия
не должна быть длиннее текста до правки. Сохрани живую разговорную неровность.

Верни ТОЛЬКО финальный русский текст, без пояснений и кавычек.
`.trim();

  const reviewedRaw = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: reviewPrompt },
    ],
    { maxTokens: 600 }
  );
  const reviewed = reviewedRaw.trim().replace(/^["«'"]|["»'"]$/g, '');

  if (!reviewed || !/[А-Яа-яЁё]/.test(reviewed)) {
    throw new Error('Редактор вернул пустой или нерусский текст');
  }
  const maxLength = Math.max(Math.round(currentEn.length * 1.2), currentEn.length + 60);
  if (reviewed.length > maxLength) {
    throw new Error(
      `Правка отклонена: редактор раздул текст с ${currentEn.length} до ${reviewed.length} символов`
    );
  }
  const violations = findHardStyleViolations(reviewed);
  if (violations.length > 0) {
    throw new Error(`Правка отклонена антистилем: ${violations.join(', ')}`);
  }
  return reviewed;
}

// Одобренный ответ публикуется на русском без скрытого перевода.
export function prepareReplyForPublication(textRu: string): string {
  return textRu.trim().replace(/^["«'"]|["»'"]$/g, '');
}
