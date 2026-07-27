import 'server-only';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export interface CodexChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CodexChatOptions {
  jsonMode?: boolean;
  maxTokens?: number;
}

const WORKDIR = '/tmp/ilyakova-codex-work';
const MODEL = 'gpt-5.5';
const TIMEOUT_MS = 180_000;

function buildPrompt(messages: CodexChatMessage[], opts: CodexChatOptions): string {
  const transcript = messages
    .map((message) => {
      const label =
        message.role === 'system'
          ? 'СИСТЕМНЫЕ ИНСТРУКЦИИ'
          : message.role === 'assistant'
            ? 'ПРЕДЫДУЩИЙ ОТВЕТ'
            : 'ЗАПРОС';
      return `${label}:\n${message.content}`;
    })
    .join('\n\n');

  const formatRule = opts.jsonMode
    ? 'Верни только валидный JSON без Markdown-ограждений и пояснений.'
    : 'Верни только готовый ответ без служебных пояснений.';

  return [
    'Ты работаешь как текстовая модель внутри личного Threads-бота.',
    'Не используй инструменты и не исследуй файловую систему.',
    'Строго следуй системным инструкциям и запросу ниже.',
    formatRule,
    opts.maxTokens
      ? `Пиши компактно; прежний лимит ответа в исходной интеграции был ${opts.maxTokens} токенов.`
      : '',
    transcript,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function codexChat(
  messages: CodexChatMessage[],
  opts: CodexChatOptions = {}
): Promise<string> {
  await mkdir(WORKDIR, { recursive: true });
  const outputPath = path.join(WORKDIR, `response-${randomUUID()}.txt`);
  const prompt = buildPrompt(messages, opts);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'codex',
        [
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--color',
          'never',
          '--output-last-message',
          outputPath,
          '-C',
          WORKDIR,
          '-m',
          MODEL,
          '-',
        ],
        {
          cwd: WORKDIR,
          env: {
            ...process.env,
            HOME: '/home/node',
            CODEX_HOME: '/home/node/.codex',
          },
          stdio: ['pipe', 'ignore', 'pipe'],
        }
      );

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Codex не ответил за 3 минуты'));
      }, TIMEOUT_MS);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Codex завершился с кодом ${code}: ${stderr}`));
      });

      child.stdin.end(prompt);
    });

    return (await readFile(outputPath, 'utf8')).trim();
  } finally {
    await rm(outputPath, { force: true });
  }
}
