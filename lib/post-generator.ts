// Генератор постов через Codex CLI с авторизацией ChatGPT.
//
// «Ильякова Тредс» сам пишет драфты постов когда:
//   - очередь почти пустая (cron /api/cron/queue-refill)
//   - пользователь вызвал /generate в Telegram
//
// Каждый сгенерированный пост идёт в Telegram как pending_approval — публикация
// только после ручного ✅. До одобрения файл в queue/ НЕ создаётся (живёт в Redis).

import { listQueue, QueueItem } from './queue';
import {
  ContentGoal,
  GOAL_SPECS,
  pickNextGoal,
  DEFAULT_MIX,
} from './content-strategy';
import {
  buildCastdevContextFromTemplate,
  loadFindings,
  pickModuleForDiscovery,
} from './castdev';
import { getPostGenerationPrompt } from './brand';
import { handleAt } from './brand-config';
import { codexChat } from './codex-chat';

async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens = 800
): Promise<string> {
  return codexChat(messages, { jsonMode: true, maxTokens });
}

export interface GeneratedPost {
  goal: ContentGoal;
  castdev_module?: string; // только для discovery
  // Legacy-название поля сохранено для совместимости с уже созданными
  // объектами в Redis. Внутри всегда русский текст.
  text_en: string;
  suggested_filename: string; // например "2026-05-28-discovery-anxiety.md"
  rationale: string; // 1-2 строки на русском — почему такой пост
}

// Последние N постов из очереди (для понимания недавней ротации и анти-повторов)
async function recentPostedItems(n = 14): Promise<QueueItem[]> {
  const items = await listQueue();
  const posted = items.filter(
    (i) => String(i.frontmatter.status ?? '').toLowerCase() === 'posted'
  );
  posted.sort((a, b) => {
    const ta = String(a.frontmatter.published_at ?? a.path);
    const tb = String(b.frontmatter.published_at ?? b.path);
    return tb.localeCompare(ta);
  });
  return posted.slice(0, n);
}

function buildRecentContext(recent: QueueItem[]): string {
  if (recent.length === 0) return '(нет данных о последних постах)';
  return recent
    .map((it, i) => {
      const goal = it.frontmatter.goal ?? '(не указан)';
      const text = (it.posts[0] ?? '').slice(0, 200);
      return `${i + 1}. [goal: ${goal}] ${text}…`;
    })
    .join('\n\n');
}

// Узнаём какие цели были у последних N постов — для ротации
function extractRecentGoals(recent: QueueItem[]): ContentGoal[] {
  return recent
    .map((it) => String(it.frontmatter.goal ?? 'brand').toLowerCase() as ContentGoal)
    .filter((g): g is ContentGoal => g === 'subscribe' || g === 'discovery' || g === 'brand');
}

// =====================================================================
// Главная функция — сгенерить пост.
// Если goal=undefined — бот сам выбирает по ротации.
// =====================================================================
export async function generatePost(forceGoal?: ContentGoal): Promise<GeneratedPost> {
  const recent = await recentPostedItems(14);
  const recentGoals = extractRecentGoals(recent);
  const goal = forceGoal ?? pickNextGoal(recentGoals);
  const spec = GOAL_SPECS[goal];

  // Для discovery — выбираем castdev-модуль и загружаем контекст из шаблона
  let castdevBlock = '';
  let castdevModuleId: string | undefined;
  if (goal === 'discovery') {
    const findings = await loadFindings();
    const castdevModule = pickModuleForDiscovery(findings);
    castdevModuleId = castdevModule.id;
    castdevBlock = `\n\n${await buildCastdevContextFromTemplate(findings)}`;
  }

  const recentBlock = buildRecentContext(recent);

  const userPrompt = `
Сгенери ОДИН пост для Threads-аккаунта ${handleAt()}.

# Тип поста: ${goal}
${spec.description}

## Чего НЕ делать
${spec.avoid.map((a) => `- ${a}`).join('\n')}

## Целевая длина первого поста
${spec.target_length_chars[0]}–${spec.target_length_chars[1]} символов.${castdevBlock}

## Последние ${recent.length} постов аккаунта (чтобы не повторяться по теме/хуку/деталям)
${recentBlock}

## Обязательные требования
- Не используй обязательную схему «хук — боль — решение — мораль».
- Выбери естественный формат из эталонных примеров: наблюдение, позиция,
  короткий кейс, реакция, вопрос или живая история.
- Не выдумывай от имени Анны факты, клиентов, результаты, цифры и события,
  которых нет в контексте.
- Не добавляй метафору или псевдомудрый вывод ради красивого финала.
- Один пост — одна конкретная мысль.

## Формат ответа — СТРОГО JSON
{
  "text_en": "готовый русский текст поста, без кавычек",
  "rationale": "1-2 предложения на русском — почему такой пост, что именно ловим"
}

Пост должен быть написан ТОЛЬКО на русском языке. Не переводи его на английский
и не добавляй английскую версию.
Никаких пояснений вне JSON.
`.trim();

  const raw = await chat(
    [
      { role: 'system', content: await getPostGenerationPrompt() },
      { role: 'user', content: userPrompt },
    ],
    900
  );

  // Парсим JSON (модель иногда оборачивает в ```json)
  let cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1];
  let parsed: { text_en: string; rationale: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`LLM вернул не-JSON: ${raw.slice(0, 300)}`);
  }

  const text = (parsed.text_en ?? '').trim().replace(/^["«'"]|["»'"]$/g, '');
  if (!text) throw new Error(`LLM вернул пустой text_en: ${raw.slice(0, 300)}`);
  if (!/[А-Яа-яЁё]/.test(text)) {
    throw new Error(`LLM вернул пост не на русском языке: ${raw.slice(0, 300)}`);
  }

  // Имя файла: дата + цель + slug из первых слов
  const today = new Date().toISOString().slice(0, 10);
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 50)
    || 'untitled';
  const filename = `${today}-ilyakova-${goal}-${slug}.md`;

  return {
    goal,
    castdev_module: castdevModuleId,
    text_en: text,
    suggested_filename: filename,
    rationale: parsed.rationale ?? '',
  };
}
