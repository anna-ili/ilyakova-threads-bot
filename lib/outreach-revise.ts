// Ревизия outreach-комментария по правке пользователя.
// Отдельный файл, чтобы route.ts мог делать dynamic import
// (не тянуть весь outreach-промпт в главный бандл).

import { BRAND, handleAt } from './brand-config';
import { codexChat } from './codex-chat';

const SYSTEM_PROMPT = `
Ты пишешь комментарий от аккаунта ${handleAt()} под чужим постом в Threads.
${BRAND.name} — ${BRAND.oneLiner}.
Тон: тёплый, живой, от первого лица.
Макс 3-4 предложения. Без URL, без цен.
{{Добавь сюда свои запретные слова, если есть.}}
`.trim();

export async function reviseOutreachComment(
  originalPostText: string,
  currentCommentEn: string,
  correctionRu: string
): Promise<{ comment_en: string; comment_ru: string }> {
  const userPrompt = `Чужой пост в Threads:
"""
${originalPostText}
"""

Текущий вариант комментария:
"""
${currentCommentEn}
"""

Правка от автора (на русском):
"""
${correctionRu}
"""

Перепиши комментарий с учётом правки. Верни JSON:
{
  "comment_en": "новый текст комментария на русском",
  "comment_ru": "тот же новый текст комментария на русском"
}`;

  const raw = await codexChat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      maxTokens: 400,
      jsonMode: true,
    }
  );

  let cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1];

  try {
    return JSON.parse(cleaned) as { comment_en: string; comment_ru: string };
  } catch {
    throw new Error('LLM parse failure при ревизии outreach-комментария');
  }
}
