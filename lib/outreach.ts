// Типы и Redis CRUD для outreach-движка.
// Outreach — комментирование чужих тредов в Threads с мягким CTA бренда.
// Задание (OutreachJob) создаётся по команде /outreach, воркер подхватывает,
// ищет посты, генерит комменты, шлёт карточки в Telegram на одобрение.
// Каждый найденный пост — OutreachItem.
import { get, set, del, keys, sadd, sismember } from './redis';

// =====================================================================
// Типы
// =====================================================================

export type OutreachJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface OutreachJob {
  id: string;
  topic: string | null;        // null = дефолтный набор запросов
  status: OutreachJobStatus;
  error?: string;              // причина failed
  items_found: number;
  items_approved: number;
  items_published: number;
  created_at: string;
  updated_at: string;
}

export type OutreachItemStatus =
  | 'awaiting_approval'
  | 'awaiting_correction'
  | 'approved'
  | 'published'
  | 'skipped'
  | 'failed';

export interface OutreachItem {
  id: string;
  job_id: string;
  thread_id: string;           // числовой media_id чужого поста (для reply_to_id)
  thread_url: string;          // permalink чужого поста
  thread_author: string;       // username автора
  thread_text: string;         // текст чужого поста
  thread_text_ru?: string;     // смысл чужого поста на русском (для карточки)
  search_query: string;        // каким запросом нашли
  tone: 'normal' | 'heavy' | 'spam';
  // Legacy-название сохранено для совместимости с Redis; текст всегда русский.
  comment_en: string;
  comment_ru: string;          // тот же русский текст для карточки
  rationale: string;           // почему такой тон
  status: OutreachItemStatus;
  corrections_ru: string[];    // история правок от пользователя
  telegram_message_id?: number;
  published_thread_reply_id?: string | null;
  created_at: string;
  updated_at: string;
}

// =====================================================================
// Redis-ключи
// =====================================================================

const JOB_KEY = (id: string) => `outreach:job:${id}`;
const ITEM_KEY = (id: string) => `outreach:item:${id}`;
const AWAITING_KEY = 'outreach:awaiting_correction';
const SEEN_SET = 'outreach:seen_threads';

// =====================================================================
// Генерация ID
// =====================================================================

export function genOutreachJobId(): string {
  return `oj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function genOutreachItemId(): string {
  return `oi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// =====================================================================
// CRUD — OutreachJob
// =====================================================================

export async function getOutreachJob(id: string): Promise<OutreachJob | null> {
  return await get<OutreachJob>(JOB_KEY(id));
}

export async function saveOutreachJob(j: OutreachJob): Promise<void> {
  j.updated_at = new Date().toISOString();
  await set(JOB_KEY(j.id), j);
}

export async function deleteOutreachJob(id: string): Promise<void> {
  await del(JOB_KEY(id));
}

// =====================================================================
// CRUD — OutreachItem
// =====================================================================

export async function getOutreachItem(id: string): Promise<OutreachItem | null> {
  return await get<OutreachItem>(ITEM_KEY(id));
}

export async function saveOutreachItem(item: OutreachItem): Promise<void> {
  item.updated_at = new Date().toISOString();
  await set(ITEM_KEY(item.id), item);
}

export async function deleteOutreachItem(id: string): Promise<void> {
  await del(ITEM_KEY(id));
}

// =====================================================================
// Awaiting correction (для правок текстом)
// =====================================================================

export async function getAwaitingOutreachId(): Promise<string | null> {
  return await get<string>(AWAITING_KEY);
}

export async function setAwaitingOutreachId(id: string | null): Promise<void> {
  if (id === null) await del(AWAITING_KEY);
  else await set(AWAITING_KEY, id);
}

// =====================================================================
// Seen threads — анти-дубли (Redis SET)
// =====================================================================

export async function markThreadSeen(threadId: string): Promise<void> {
  await sadd(SEEN_SET, threadId);
}

export async function isThreadSeen(threadId: string): Promise<boolean> {
  return await sismember(SEEN_SET, threadId);
}

// =====================================================================
// Список всех item'ов конкретного job'а
// =====================================================================

export async function listOutreachItems(jobId: string): Promise<OutreachItem[]> {
  const allKeys = await keys('outreach:item:oi_*');
  const items: OutreachItem[] = [];
  for (const k of allKeys) {
    const item = await get<OutreachItem>(k);
    if (item && item.job_id === jobId) items.push(item);
  }
  return items;
}
