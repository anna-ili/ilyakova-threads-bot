// Обёртка над Upstash Redis REST API.
// Используется для хранения состояния (какие реплаи видели, активные диалоги бота).

const REST_URL = () => {
  const u = process.env.UPSTASH_REDIS_REST_URL;
  if (!u) throw new Error('UPSTASH_REDIS_REST_URL не задан');
  return u.replace(/\/$/, '');
};
const REST_TOKEN = () => {
  const t = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!t) throw new Error('UPSTASH_REDIS_REST_TOKEN не задан');
  return t;
};

// Универсальный pipeline-вызов (один POST с массивом команд, если надо батчить).
// Cache-Control: no-store — Next.js fetch иначе кеширует GET-эквивалентные ответы,
// и каждый watcher-запуск получает stale данные с пустыми Set'ами.
export async function cmdRaw(args: (string | number)[]): Promise<any> {
  return cmd(args);
}

async function cmd(args: (string | number)[]): Promise<any> {
  const res = await fetch(`${REST_URL()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN()}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis ${args[0]} failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { result?: any; error?: string };
  if (data.error) throw new Error(`Redis ${args[0]} error: ${data.error}`);
  return data.result;
}

export async function get<T = any>(key: string): Promise<T | null> {
  const raw = await cmd(['GET', key]);
  if (raw === null || raw === undefined) return null;
  // Upstash REST API в зависимости от значения может вернуть либо строку,
  // либо уже распарсенный JSON. Поэтому если уже object — возвращаем как есть.
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return raw as any;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as any;
  }
}

export async function set<T = any>(key: string, value: T): Promise<void> {
  await cmd(['SET', key, JSON.stringify(value)]);
}

export async function del(key: string): Promise<void> {
  await cmd(['DEL', key]);
}

// Set с атомарной операцией «создать если нет» — не используется пока, но полезно иметь.
export async function setnx<T = any>(key: string, value: T): Promise<boolean> {
  const r = (await cmd(['SET', key, JSON.stringify(value), 'NX'])) as string | null;
  return r === 'OK';
}

// Атомарный lock с авто-протуханием: SET key val NX EX <ttl>.
// Возвращает true, если лок взят (ключа не было). С TTL — чтобы упавший
// процесс не оставил вечный лок. Используется для защиты от двойной публикации.
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const r = (await cmd(['SET', key, '1', 'NX', 'EX', ttlSeconds])) as string | null;
  return r === 'OK';
}

// Снять лок вручную (если работа завершилась раньше TTL).
export async function releaseLock(key: string): Promise<void> {
  await del(key);
}

// Пометить значение с TTL (для «этот пост уже опубликован» — анти-дубль).
export async function setWithTtl<T = any>(key: string, value: T, ttlSeconds: number): Promise<void> {
  await cmd(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
}

// SADD / SMEMBERS / SISMEMBER — для хранения множества viewed reply ids.
// Для каждого post_id свой ключ `seen:replies:<post_id>` = SET из reply_id.
export async function sadd(key: string, ...members: string[]): Promise<number> {
  if (members.length === 0) return 0;
  return (await cmd(['SADD', key, ...members])) as number;
}

export async function sismember(key: string, member: string): Promise<boolean> {
  const r = await cmd(['SISMEMBER', key, member]);
  return Number(r) === 1;
}

export async function smembers(key: string): Promise<string[]> {
  return ((await cmd(['SMEMBERS', key])) as string[]) ?? [];
}

// KEYS с pattern — для списка всех активных диалогов.
// ВАЖНО: на Vercel runtime Upstash не отрабатывает glob с двоеточием в pattern
// (KEYS dialog:* возвращает []). Получаем все ключи и фильтруем в JS.
// На бесплатном тире это ок, пока ключей мало. Если станет много — перейти на SCAN.
export async function keys(pattern: string): Promise<string[]> {
  const all = ((await cmd(['KEYS', '*'])) as string[]) ?? [];
  if (pattern === '*') return all;
  // Превращаем glob в RegExp: `*` → `.*`, остальное экранируем
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return all.filter((k) => re.test(k));
}
