// Состояние редактирования последнего опубликованного поста.
// Отдельный flow от dialog (который для ответов на комменты).
// Хранится в Redis под ключом post-edit:<id>.
import { get, set, del, keys } from './redis';

export type PostEditStatus =
  | 'awaiting_correction' // ждём от пользователя правку русским текстом
  | 'awaiting_approval' // показали новый русский вариант, ждём ✅/❌
  | 'done';

export interface PostEdit {
  id: string;
  // Что правим — данные исходного опубликованного поста
  queue_path: string; // например "queue/2026-05-26-foo.md"
  threads_post_id: string;
  threads_url: string;
  original_text_en: string; // legacy-название: оригинал русского поста
  // Свежий вариант после правок (накапливаем итерации)
  current_text_en: string; // legacy-название: текущий русский вариант
  // История правок пользователя на русском (для контекста LLM)
  corrections_ru: string[];
  status: PostEditStatus;
  telegram_message_id?: number;
  created_at: string;
  updated_at: string;
}

const KEY = (id: string) => `post-edit:${id}`;
const AWAITING_KEY = 'post-edit:awaiting';

export async function getPostEdit(id: string): Promise<PostEdit | null> {
  return await get<PostEdit>(KEY(id));
}

export async function savePostEdit(p: PostEdit): Promise<void> {
  p.updated_at = new Date().toISOString();
  await set(KEY(p.id), p);
}

export async function deletePostEdit(id: string): Promise<void> {
  await del(KEY(id));
}

export async function getAwaitingPostEditId(): Promise<string | null> {
  return await get<string>(AWAITING_KEY);
}

export async function setAwaitingPostEditId(id: string | null): Promise<void> {
  if (id === null) await del(AWAITING_KEY);
  else await set(AWAITING_KEY, id);
}

export function genPostEditId(): string {
  return `pe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Найти все активные правки (для очистки)
export async function listActivePostEdits(): Promise<PostEdit[]> {
  const ks = await keys('post-edit:pe_*');
  const out: PostEdit[] = [];
  for (const k of ks) {
    const p = await get<PostEdit>(k);
    if (p && p.status !== 'done') out.push(p);
  }
  return out;
}
