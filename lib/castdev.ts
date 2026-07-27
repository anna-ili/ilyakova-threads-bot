// Кастдев-инструмент для discovery-постов «Ильякова Тредс».
//
// ============================================================================
// ИНСТРУКЦИЯ: модули M1 и M2 ниже — шаблоны. Перепиши goal, forces,
// focus_areas, example_questions и avoid ПОД СВОЙ ПРОДУКТ.
// Логику (loadFindings, pickModuleForDiscovery, buildCastdevContext) НЕ трогай.
// ============================================================================
//
// Цель: discovery-посты в Threads должны не "постить ради постинга", а вытягивать
// из аудитории конкретные инсайты, которые помогают развивать продукт.
//
// Под капотом — выжимка из Synth_castdev_tool (M1 "Барьеры и мотивы", M2 "JTBD"),
// адаптированная под формат коротких постов (а не часовых интервью).
//
// Каждый discovery-пост таргетирует один CastdevModule. Когда бот генерит пост:
//   1. Выбирает модуль с наименьшим количеством findings (т.е. меньше всего знаем)
//   2. Берет оттуда фокус-зону и примеры вопросов
//   3. Учитывает уже накопленные findings — чтобы не спрашивать то что уже знаем
//   4. Формирует пост: хук + контр-интуитивный тейк + точечный вопрос из модуля
//
// Findings собираются вручную (или еженедельным анализом, см. weekly-analysis.ts)
// и хранятся в repo: queue/castdev_findings.md

import { getFile } from './github';
import { loadTemplate } from './load-template';

export type CastdevModuleId = 'M1_barriers' | 'M2_jtbd';

export interface CastdevModule {
  id: CastdevModuleId;
  name: string;
  // Что хотим узнать (для system prompt бота)
  goal: string;
  // Какие силы исследуем (для понимания контекста)
  forces: string;
  // Зоны для копания — бот выбирает одну для каждого discovery-поста
  focus_areas: string[];
  // Эталонные вопросы (НЕ вставлять дословно — это примеры голоса)
  example_questions: string[];
  // Что НЕ спрашивать (banal / known / off-strategy)
  avoid: string[];
}

export const CASTDEV_MODULES: CastdevModule[] = [
  {
    id: 'M1_barriers',
    name: 'M1 — Барьеры и мотивы',
    goal:
      '{{Понять, почему люди НЕ начинают пользоваться продуктом. Какая привычка / тревога / отговорка их держит. И что должно случиться, чтобы они начали.}}',
    forces:
      '{{Push (что толкает уйти от текущего решения) -> Pull (что притягивает к продукту) -> Anxiety (что страшно: вдруг не получится / сложно) -> Habit (инерция текущего поведения).}}',
    focus_areas: [
      '{{Триггер: что должно случиться, чтобы человек ВПЕРВЫЕ задумался о решении проблемы?}}',
      '{{Anxiety про результат: чего боятся, когда представляют, что начнут?}}',
      '{{Anxiety про процесс: что страшно в самом действии?}}',
      '{{Привычка-замена: что они делают ВМЕСТО вашего продукта?}}',
      '{{Стоимость бездействия: что они теряют от того что не решают проблему?}}',
      '{{Социальная работа: что бы они хотели сказать миру, решив эту проблему?}}',
    ],
    example_questions: [
      '{{What\'s the one thing that would actually make you start? Not someday -- this weekend.}}',
      '{{When you imagine sitting down to do it, what\'s the first thing that stops you?}}',
      '{{What are you doing about this right now? (Honestly. Not what you SHOULD do.)}}',
      '{{What would change if you solved this tomorrow?}}',
      '{{What\'s the actual cost of waiting another year?}}',
    ],
    avoid: [
      '{{НЕ спрашивать банальное, на что ответ очевиден (да/нет).}}',
      '{{НЕ предлагать варианты ответа множественным выбором — нужны открытые ответы.}}',
    ],
  },
  {
    id: 'M2_jtbd',
    name: 'M2 — JTBD: для какой работы нанимают',
    goal:
      '{{Понять, какую РАБОТУ люди нанимают продукт делать. Это про удобство? Про статус? Про контроль? Про экономию времени? Это все разные продукты.}}',
    forces:
      '{{Контекст найма (рутина / триггер / разово) x Эмоциональная работа (контроль / облегчение / принадлежность / рост) x Социальная работа (как хочешь выглядеть).}}',
    focus_areas: [
      '{{Триггерный контекст: что случилось в последние месяцы, что заставило задуматься о продукте?}}',
      '{{Эмоциональная работа: какое внутреннее состояние хочется получить?}}',
      '{{Социальная работа: что хотят, чтобы про них думали окружающие?}}',
      '{{Альтернативы: что уже наняли на эту работу? Что используют вместо?}}',
      '{{Прогресс: после использования — что дальше?}}',
      '{{Работа НЕ-выполнения: что получают от того что НЕ решают проблему?}}',
    ],
    example_questions: [
      '{{When you imagine the result — what do you do with it on day one?}}',
      '{{What did you "hire" instead of this? (Another tool? Manual process? Just hoping?)}}',
      '{{What would you call yourself if you finished this?}}',
      '{{What\'s the actual scenario where someone else benefits from your result?}}',
    ],
    avoid: [
      '{{НЕ спрашивать "сколько вы готовы заплатить" — JTBD не про цену.}}',
      '{{НЕ спрашивать "нужен ли вам продукт" — нужны мотивы и контекст, не намерение.}}',
      '{{НЕ начинать с продукта — сначала job, потом продукт.}}',
    ],
  },
];

export function getCastdevModule(id: CastdevModuleId): CastdevModule | undefined {
  return CASTDEV_MODULES.find((m) => m.id === id);
}

// ====================================================================
// Findings — что мы УЖЕ узнали из комментов. Хранится в queue/castdev_findings.md
// ====================================================================

export interface Findings {
  by_module: Record<CastdevModuleId, string[]>;
  raw: string;
}

export async function loadFindings(): Promise<Findings> {
  const file = await getFile('queue/castdev_findings.md').catch(() => null);
  const empty: Findings = {
    by_module: { M1_barriers: [], M2_jtbd: [] },
    raw: '',
  };
  if (!file) return empty;

  const raw = file.content;
  // Парсим секции вида:
  // ## M1_barriers
  // - finding 1
  // - finding 2
  // ## M2_jtbd
  // - ...
  const out: Findings = { by_module: { M1_barriers: [], M2_jtbd: [] }, raw };
  let current: CastdevModuleId | null = null;
  for (const line of raw.split('\n')) {
    const sec = /^##\s+(M1_barriers|M2_jtbd)\b/.exec(line);
    if (sec) {
      current = sec[1] as CastdevModuleId;
      continue;
    }
    if (!current) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    if (bullet) out.by_module[current].push(bullet[1]);
  }
  return out;
}

// Какой модуль выбрать для очередного discovery-поста.
// Простая стратегия: тот по которому findings меньше (значит меньше знаем).
export function pickModuleForDiscovery(findings: Findings): CastdevModule {
  let least = CASTDEV_MODULES[0];
  let leastCount = findings.by_module[least.id]?.length ?? 0;
  for (const m of CASTDEV_MODULES.slice(1)) {
    const c = findings.by_module[m.id]?.length ?? 0;
    if (c < leastCount) {
      least = m;
      leastCount = c;
    }
  }
  return least;
}

// Готовый блок контекста для system-prompt бота при генерации discovery-поста.
// Включает: цель модуля, фокус, что НЕ спрашивать, и что уже знаем.
export function buildCastdevContext(module: CastdevModule, findings: Findings): string {
  const known = findings.by_module[module.id] ?? [];
  const knownBlock = known.length > 0
    ? `\n## Что мы УЖЕ знаем по этой теме (НЕ спрашивай это снова)
Это findings, подтверждённые >=5 разными юзерами — то есть это РЕАЛЬНОСТЬ нашей аудитории.
${known.map((f) => `- ${f}`).join('\n')}

Твоя задача — копать ГЛУБЖЕ этих findings, не возвращаться к ним.`
    : '\n## Что мы УЖЕ знаем по этой теме\n(пока ничего — это первые посты по теме, можно копать любое из фокус-зон)';

  return `
# Castdev-модуль для этого поста: ${module.name}

## Цель — что хотим узнать
${module.goal}

## Какие силы исследуем
${module.forces}

## Фокус-зоны (выбери ОДНУ и копай только её)
${module.focus_areas.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Эталонные вопросы (для понимания голоса; НЕ копируй дословно)
${module.example_questions.map((q) => `- ${q}`).join('\n')}

## Чего НЕ делать
${module.avoid.map((a) => `- ${a}`).join('\n')}
${knownBlock}
`.trim();
}

// ====================================================================
// Загрузка текста кастдев-модулей из prompts/castdev.md.
// Используется в buildCastdevContextFromTemplate — чтобы содержательный
// текст (вопросы, фокус-зоны) жил в markdown, а не в .ts.
// ====================================================================

export async function loadCastdevModulesText(): Promise<string> {
  return await loadTemplate('castdev.md');
}

// Формирование блока findings для промпта (общая логика).
function buildKnownBlock(findings: Findings): string {
  const allKnown: string[] = [];
  for (const modId of Object.keys(findings.by_module) as CastdevModuleId[]) {
    const items = findings.by_module[modId] ?? [];
    if (items.length > 0) {
      allKnown.push(`### ${modId}`, ...items.map((f) => `- ${f}`));
    }
  }
  if (allKnown.length > 0) {
    return `\n## Что мы УЖЕ знаем (НЕ спрашивай это снова)
Это findings, подтверждённые >=5 разными юзерами — реальность аудитории.
${allKnown.join('\n')}

Копай ГЛУБЖЕ этих findings, не возвращайся к ним.`;
  }
  return '\n## Что мы УЖЕ знаем\n(пока ничего — первые посты, можно копать любую фокус-зону)';
}

// Async-вариант buildCastdevContext: берёт текст модулей из prompts/castdev.md,
// добавляет блок «что мы уже знаем» из findings. Вызывается из post-generator.
export async function buildCastdevContextFromTemplate(findings: Findings): Promise<string> {
  const modulesText = await loadCastdevModulesText();
  const knownBlock = buildKnownBlock(findings);
  return `${modulesText}\n${knownBlock}`;
}
