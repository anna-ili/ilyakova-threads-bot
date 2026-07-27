// Состояние одобрения авто-сгенерированных постов от «Ильякова Тредс».
// Когда бот генерит пост, он живёт в Redis под ключом draft:<id>.
// До одобрения файл в queue/ НЕ создаётся.
//
// Flow:
//   1. /generate или cron queue-refill → genDraft → Telegram с кнопками
//   2. Пользователь жмёт ✅ → сохраняем в queue/, статус draft → попадает в autopost cron
//   3. ✍️ Правка → reviseDraft (та же логика что и для опубликованных постов)
//   4. ❌ Отмена → удаляем из Redis, в queue/ не попадает
import { get, set, del, keys } from './redis';
import type { ContentGoal } from './content-strategy';

export type PostDraftStatus =
  | 'awaiting_approval'
  | 'awaiting_correction'
  | 'approved'
  | 'rejected';

export interface PostDraft {
  id: string;
  goal: ContentGoal;
  castdev_module?: string;
  text_en: string;
  suggested_filename: string;
  rationale: string;
  // Для иterативной правки
  corrections_ru: string[];
  status: PostDraftStatus;
  telegram_message_id?: number;
  created_at: string;
  updated_at: string;
}

const KEY = (id: string) => `draft:${id}`;
const AWAITING_KEY = 'draft:awaiting';

export async function getDraft(id: string): Promise<PostDraft | null> {
  return await get<PostDraft>(KEY(id));
}

export async function saveDraft(d: PostDraft): Promise<void> {
  d.updated_at = new Date().toISOString();
  await set(KEY(d.id), d);
}

export async function deleteDraft(id: string): Promise<void> {
  await del(KEY(id));
}

export async function getAwaitingDraftId(): Promise<string | null> {
  return await get<string>(AWAITING_KEY);
}

export async function setAwaitingDraftId(id: string | null): Promise<void> {
  if (id === null) await del(AWAITING_KEY);
  else await set(AWAITING_KEY, id);
}

export function genDraftId(): string {
  return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function listPendingDrafts(): Promise<PostDraft[]> {
  const ks = await keys('draft:dr_*');
  const out: PostDraft[] = [];
  for (const k of ks) {
    const d = await get<PostDraft>(k);
    if (d && d.status === 'awaiting_approval') out.push(d);
  }
  return out;
}
