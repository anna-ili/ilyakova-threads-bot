// Состояние диалогов с «Ильякова Тредс» — в Upstash Redis.
// Каждый диалог — отдельный ключ `dialog:<id>`, значение — JSON объекта Dialog.
// Плюс глобальные ключи: `dialog:awaiting_correction` (id диалога, ждущего правки).
import { get, set, del, keys } from './redis';

export type DialogStatus =
  | 'awaiting_approval'
  | 'awaiting_correction'
  | 'scheduled_publish'
  | 'done';

export interface Dialog {
  id: string;
  root_reply_id: string;
  reply_ids: string[];
  reply_username: string;
  reply_text_en: string;
  reply_permalink: string;
  post_id: string;
  post_text: string;
  post_filename: string;
  comment_ru: string;
  draft_ru: string;
  status: DialogStatus;
  skip_reason?: string;
  publish_at?: string;
  reply_text_en_final?: string;
  telegram_message_id?: number;
  created_at: string;
  updated_at: string;
}

const DIALOG_KEY = (id: string) => `dialog:${id}`;
const AWAITING_CORRECTION_KEY = 'dialog:awaiting_correction';
// Для scheduled publisher'а — список ID одобренных к публикации.
// Используем просто keys('dialog:*') + фильтр по статусу. Это ок при небольшом числе активных.

export async function getDialog(id: string): Promise<Dialog | null> {
  return await get<Dialog>(DIALOG_KEY(id));
}

export async function saveDialog(d: Dialog): Promise<void> {
  d.updated_at = new Date().toISOString();
  await set(DIALOG_KEY(d.id), d);
}

export async function deleteDialog(id: string): Promise<void> {
  await del(DIALOG_KEY(id));
}

// Все активные диалоги — кроме done. Для админских операций / scheduled publisher.
export async function listActiveDialogs(): Promise<Dialog[]> {
  const ks = await keys('dialog:*');
  // Фильтруем технические ключи вроде dialog:awaiting_correction
  const dialogKeys = ks.filter((k) => k.startsWith('dialog:d_'));
  const result: Dialog[] = [];
  for (const k of dialogKeys) {
    const d = await get<Dialog>(k);
    if (d && d.status !== 'done') result.push(d);
  }
  return result;
}

// Диалоги, готовые к публикации (status=scheduled_publish, publish_at в прошлом).
export async function listDuePublish(): Promise<Dialog[]> {
  const active = await listActiveDialogs();
  const now = Date.now();
  return active.filter(
    (d) => d.status === 'scheduled_publish' && d.publish_at && new Date(d.publish_at).getTime() <= now
  );
}

export async function getAwaitingCorrectionId(): Promise<string | null> {
  return await get<string>(AWAITING_CORRECTION_KEY);
}

export async function setAwaitingCorrectionId(id: string | null): Promise<void> {
  if (id === null) await del(AWAITING_CORRECTION_KEY);
  else await set(AWAITING_CORRECTION_KEY, id);
}

export function genDialogId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
