// Загрузка фото из Telegram → в public/media/ репо через GitHub API.
// Используется когда пользователь шлёт фото в чат с «Ильякова Тредс».
import { putFile } from './github';

// Telegram getFile вернёт file_path относительно их CDN
async function tgGetFile(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = (await res.json()) as { ok: boolean; result?: { file_path: string }; description?: string };
  if (!data.ok || !data.result) throw new Error(`Telegram getFile: ${data.description ?? 'нет результата'}`);
  return data.result.file_path;
}

async function tgDownloadFile(filePath: string): Promise<{ buffer: Buffer; contentType: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download photo failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  // Telegram photos в JPEG по умолчанию, но проверяем по content-type
  const ct = res.headers.get('content-type') ?? 'image/jpeg';
  return { buffer: Buffer.from(ab), contentType: ct };
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

// Скачивает фото из Telegram и кладёт в public/media/<subfolder>/<filename>.
// Возвращает относительный путь от корня сайта (например "/media/abc/photo.jpg").
export async function downloadTelegramPhotoToRepo(
  fileId: string,
  subfolder: string,
  filename?: string
): Promise<{ public_path: string; repo_path: string }> {
  const filePath = await tgGetFile(fileId);
  const { buffer, contentType } = await tgDownloadFile(filePath);
  const ext = extFromContentType(contentType);
  const name = filename ?? `photo-${Date.now()}.${ext}`;
  const repoPath = `public/media/${subfolder}/${name}`;
  // putFile принимает текст — но base64-encode'ит. Нам нужен бинарь.
  // putFile внутри: Buffer.from(content, 'utf-8').toString('base64')
  // Для бинаря — передаём как latin1 строку, чтобы Buffer.from(content,'utf-8')
  // не покорёжил байты. Альтернатива — сделать putFile принимающим Buffer.
  // Делаем проще: передаём строку, в которой каждый байт = char, и base64-енкодим тут.
  // Но putFile не принимает уже base64. Поэтому делаем прямой PUT через github.ts.
  await putFileBinary(repoPath, buffer);
  const publicPath = `/${repoPath.replace(/^public\//, 'media/').replace('media/', 'media/')}`;
  // Корректнее: путь к публичному ассету — без префикса public/
  // public/media/foo/bar.jpg → /media/foo/bar.jpg
  const cleanPublic = '/' + repoPath.replace(/^public\//, '');
  return { public_path: cleanPublic, repo_path: repoPath };
}

// Прямой PUT бинарника в GitHub (минуя текстовый putFile)
async function putFileBinary(path: string, content: Buffer): Promise<void> {
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) throw new Error('GITHUB_* env не заданы');

  // Проверяем существует ли файл (если да — нужен sha для перезаписи)
  let sha: string | undefined;
  try {
    const head = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (head.ok) {
      const data = (await head.json()) as { sha?: string };
      sha = data.sha;
    }
  } catch {}

  const body: any = {
    message: `media: upload ${path.split('/').pop()}`,
    content: content.toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} ${text}`);
  }
}
