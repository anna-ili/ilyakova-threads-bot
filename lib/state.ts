// Какие реплаи бот уже видел — храним в Redis как SET per post_id.
// Ключ: `seen:replies:<post_id>`, значения — reply_id.
import { sadd, sismember } from './redis';

export async function isReplySeen(postId: string, replyId: string): Promise<boolean> {
  return await sismember(`seen:replies:${postId}`, replyId);
}

export async function markReplySeen(postId: string, ...replyIds: string[]): Promise<void> {
  if (replyIds.length === 0) return;
  await sadd(`seen:replies:${postId}`, ...replyIds);
}
