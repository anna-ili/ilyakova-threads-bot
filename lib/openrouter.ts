// Клиент OpenRouter. Используется для генерации черновиков ответов и перевода на английский.
import { getBrandVoicePrompt, DraftResult } from './brand';
import { BRAND } from './brand-config';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4.6';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(messages: ChatMessage[], opts: { jsonMode?: boolean; maxTokens?: number } = {}): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY не задан');

  const body: any = {
    model: MODEL,
    messages,
    max_tokens: opts.maxTokens ?? 800,
    temperature: 0.6,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://your-app.vercel.app',
      'X-Title': 'Threads Bot',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

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
  "comment_ru": "перевод комментария на русский (всегда)",
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
// фразу», «добавь уточняющий вопрос») — бот переписывает английский пост.
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

Оригинал, как был опубликован (EN):
"""
${ctx.originalEn}
"""

${ctx.currentEn !== ctx.originalEn ? `Текущий вариант после предыдущих правок (EN):\n"""\n${ctx.currentEn}\n"""\n` : ''}
Правки автора (русский, по порядку — последняя самая важная):
${corrections}

Перепиши пост на естественном английском с учётом ВСЕХ правок. Не добавляй
от себя то, чего не было — только то что просили. Верни ТОЛЬКО новый
английский текст поста, без пояснений и без кавычек.
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
  const userPrompt = `
Это черновик поста для Threads-аккаунта бренда, который написал бот «Ильякова Тредс» и
который ещё НЕ опубликован. Автор канала просит внести правки.

Исходный драфт (EN):
"""
${originalEn}
"""

${currentEn !== originalEn ? `Текущий вариант после предыдущих правок (EN):\n"""\n${currentEn}\n"""\n` : ''}
Правки автора (русский, по порядку — последняя самая важная):
${corr}

Перепиши пост на естественном английском с учётом ВСЕХ правок. Сохраняй
голос бренда (см. system prompt). Не добавляй от себя того, чего не
просили. Верни ТОЛЬКО новый английский текст, без пояснений и без кавычек.
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

// Перевод одобренного русского черновика в английский для публикации в Threads.
export async function translateToEnglish(textRu: string, ctx: CommentContext): Promise<string> {
  const userPrompt = `
Контекст — пост в Threads:
"""
${ctx.postText}
"""

Комментарий, на который отвечаем:
"""
${ctx.replyText}
"""

Текст ответа на русском:
"""
${textRu}
"""

Переведи на естественный разговорный английский в голосе ${BRAND.name} (тёплый
спокойный человек, который сам пользуется продуктом; не маркетолог).
Не дословный перевод — адаптируй, чтобы звучало нативно. Если в тексте есть
уточняющий вопрос — сохрани его живым и естественным. Верни ТОЛЬКО английский
текст, без пояснений и кавычек.
`.trim();

  const raw = await chat(
    [
      { role: 'system', content: await getBrandVoicePrompt() },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 400 }
  );
  return raw.trim().replace(/^["«'"]|["»'"]$/g, '');
}
