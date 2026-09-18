// forge-discover — разведка работы для forge. Код НЕ трогает (L1, report-only).
// Собирает ошибки логики и кода из четырёх источников, опровергает каждую находку
// независимым агентом и пишет подтверждённые карточками в STATE.md на разбор человеку.
//
// Источники:
//   MECH      — lint / typecheck / tests (механика, без суждений) + baseline для forge
//   IR        — docs/druid/ir.json: ресурс ↔ роут/схема/валидаторы в коде
//   BEHAVIOR  — docs/druid/behavior/*.md: контракты ↔ код (не реализовано ≠ ошибка, идёт отдельным списком)
//   DEEP      — модули src: ошибки логики без спеки (гарды, сравнения, ветки, типы)
//
// Запуск: Workflow({ scriptPath: ".../discover.workflow.js", args: { ...cfg } })
// args (опционально):
//   projectPath  — git-репо бэкенда (здесь же .agent-loop/)
//   extraPaths   — другие кодовые базы, где искать реализацию behavior (напр. frontend-app)
//   stateFile    — STATE.md, куда писать карточки
//   druidDir     — папка с ir.json и behavior/
//   gates        — { lint, test } shell-команды
//   maxTokens    — потолок токенов на прогон; фазы после исчерпания пропускаются с записью в лог
//   runAt        — строка даты для заголовка (скрипту Date недоступен)

export const meta = {
  name: 'forge-discover',
  description: 'Разведка: lint/tests, сверка кода с DRUID IR и behavior, глубокое ревью модулей, опровержение, карточки в STATE.md',
  phases: [
    { title: 'SCOUT', detail: 'список ресурсов IR, behavior-файлов, модулей' },
    { title: 'MECH', detail: 'lint / typecheck / tests → baseline' },
    { title: 'IR', detail: 'ресурс IR ↔ код' },
    { title: 'BEHAVIOR', detail: 'контракт ↔ код' },
    { title: 'DEEP', detail: 'логика модулей' },
    { title: 'VERIFY', detail: 'опровержение каждой находки' },
    { title: 'WRITE', detail: 'карточки в STATE.md' },
  ],
}

const cfg = {
  projectPath: '/path/to/your-project',
  extraPaths: ['/path/to/your-frontend'],
  stateFile: '/path/to/your-project/STATE.md',
  druidDir: '/path/to/your-project/docs/druid',
  gates: { lint: 'bun run lint', test: 'bun run test' },
  maxTokens: 3_000_000,
  runAt: '',
  ...(args || {}),
}
const P = cfg.projectPath
const D = cfg.druidDir
const CODEBASES = [P, ...cfg.extraPaths].join(', ')

const FINDING = {
  type: 'object',
  required: ['title', 'file', 'line', 'code', 'analysis', 'cause', 'spec_ref', 'fix_options', 'done_criterion', 'severity'],
  properties: {
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    code: { type: 'string' },
    analysis: { type: 'string' },
    cause: { type: 'string' },
    spec_ref: { type: 'string' },
    fix_options: { type: 'array', items: { type: 'string' } },
    done_criterion: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}
const FINDINGS = {
  type: 'object',
  required: ['findings', 'not_implemented'],
  properties: {
    findings: { type: 'array', items: FINDING },
    not_implemented: { type: 'array', items: { type: 'string' } },
  },
}
const SCOUT = {
  type: 'object',
  required: ['ir_resources', 'behavior_files', 'modules'],
  properties: {
    ir_resources: { type: 'array', items: { type: 'string' } },
    behavior_files: { type: 'array', items: { type: 'string' } },
    modules: { type: 'array', items: { type: 'string' } },
  },
}
const MECH = {
  type: 'object',
  required: ['lint_errors', 'tests_passed', 'tests_failed', 'tests_runnable', 'findings'],
  properties: {
    lint_errors: { type: 'integer' },
    tests_passed: { type: 'integer' },
    tests_failed: { type: 'integer' },
    tests_runnable: { type: 'boolean' },
    findings: { type: 'array', items: FINDING },
  },
}
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const RULES = `Правила находки: только то, что подтверждается кодом (файл:строка и фрагмент кода обязательны).
"Не реализовано" — НЕ находка, а пункт not_implemented ("<спека> § <контракт>: кода нет"). Стиль, именование, форматирование — не находки.
Каждая находка: title (одна строка), file (путь от корня репо), line, code (фрагмент 3-15 строк), analysis (что делает код и что требует спека/логика),
cause (корень), spec_ref (файл спеки и раздел, или "нет спеки" для DEEP), fix_options (2-3 варианта, конкретно), done_criterion (проверяемо: тест/команда/поведение), severity.`

const tokensAtStart = budget.spent()
const spentK = () => Math.round((budget.spent() - tokensAtStart) / 1000)
const tokensLeft = () => cfg.maxTokens - (budget.spent() - tokensAtStart)
const skipped = []
const canRun = (name, need) => {
  if (tokensLeft() > need && !(budget.total && budget.remaining() < need)) return true
  skipped.push(name)
  log(`⛔ ${name} пропущена: потолок токенов (${spentK()}k из ${Math.round(cfg.maxTokens / 1000)}k)`)
  return false
}
const tag = (kind, list) => (list || []).filter(Boolean).map((f) => ({ ...f, kind }))

phase('SCOUT')
const scout = await agent(
  `Через Read/Glob/Bash (только чтение) собери:
- ir_resources: имена ресурсов из ${D}/ir.json ("resources[].name") — все.
- behavior_files: имена файлов в ${D}/behavior/.
- modules: подпапки с .ts/.tsx в ${P}/src (глубина 2, напр. "src/server/routes", "src/db/actions", "src/shared/helpers") и в ${P}/frontend/src (глубина 2). Только папки, где есть код; без tests, types, consts.
Верни списки.`,
  { schema: SCOUT, agentType: 'explorer', phase: 'SCOUT', effort: 'low' },
)
if (!scout) throw new Error('SCOUT не вернул списки')
log(`IR: ${scout.ir_resources.length} ресурсов, behavior: ${scout.behavior_files.length}, модулей: ${scout.modules.length}`)

phase('MECH')
const mech = await agent(
  `cd ${P}. Код не менять.
1. Запусти "${cfg.gates.lint}". lint_errors = число ошибок biome + tsc. Каждую ошибку типов/линта, указывающую на ЛОГИЧЕСКУЮ проблему (не стиль), оформи находкой по правилам ниже; чисто стилевые не включай, только посчитай.
2. Запусти "${cfg.gates.test}". Если тесты не поднимаются (нет БД, нет env) — tests_runnable=false, tests_passed=0, tests_failed=0 и ОДНА находка "тесты не запускаются: <причина>". Иначе tests_runnable=true, числа passed/failed, каждый красный тест — находка.
3. Запиши ${P}/.agent-loop/baseline.json: {"testsPassed": N, "lintErrors": M, "testsRunnable": bool} (создай папку если нет).
${RULES}`,
  { schema: MECH, agentType: 'coder', phase: 'MECH' },
)
const baseline = mech ? { lint: mech.lint_errors, passed: mech.tests_passed, failed: mech.tests_failed, runnable: mech.tests_runnable } : null
log(`MECH: lint ${baseline ? baseline.lint : '?'}, tests ${baseline ? `${baseline.passed}/${baseline.failed}${baseline.runnable ? '' : ' (не запускаются)'}` : '?'}`)

let raw = tag('mech', mech ? mech.findings : [])
const notImpl = []

if (canRun('IR', 300_000)) {
  phase('IR')
  const ir = await parallel(
    scout.ir_resources.map((name) => () =>
      agent(
        `Ресурс "${name}" из ${D}/ir.json (найди его объект в resources; учти x-notes в корне файла — там правила путей, типов, шифрования).
Если у ресурса x-existing != true И роута под его path в ${P}/src/server/routes нет — это не реализовано: одна строка в not_implemented, findings пусто.
Иначе сверь с кодом в ${P}/src (routes, shared/schemas, db/actions, db/pg): path и operations, attributes (nullable/readonly/default), permit, validators, unique, x-role-values.
Находка = код расходится с IR (лишнее поле принимается, обязательное не проверяется, метод/путь не совпадает, readonly меняется, unique не обеспечен).
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-logical', phase: 'IR', label: `ir:${name}` },
      ),
    ),
  )
  for (const r of ir.filter(Boolean)) {
    raw.push(...tag('ir', r.findings))
    notImpl.push(...r.not_implemented)
  }
  log(`IR: ${raw.filter((f) => f.kind === 'ir').length} находок, не реализовано: ${notImpl.length}`)
}

if (canRun('BEHAVIOR', 300_000)) {
  phase('BEHAVIOR')
  const beh = await parallel(
    scout.behavior_files.map((file) => () =>
      agent(
        `Прочитай ${D}/behavior/${file}. Это behavioral spec (invariant / pre / post по операциям).
Найди реализующий код в: ${CODEBASES} (grep по сущности, полям, статусам, путям). Для КАЖДОГО контракта реши: реализован верно / реализован с расхождением / кода нет.
Расхождение → находка. Кода нет → строка not_implemented вида "${file} § <операция>: кода нет в <где искал>". Верно → ничего.
Прототип в frontend-app — тоже код: расхождение фронтового поведения с контрактом считается.
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-logical', phase: 'BEHAVIOR', label: `behavior:${file}` },
      ),
    ),
  )
  for (const r of beh.filter(Boolean)) {
    raw.push(...tag('behavior', r.findings))
    notImpl.push(...r.not_implemented)
  }
  log(`BEHAVIOR: ${raw.filter((f) => f.kind === 'behavior').length} находок, не реализовано: ${notImpl.length}`)
}

if (canRun('DEEP', 400_000)) {
  phase('DEEP')
  const deep = await parallel(
    scout.modules.map((mod) => () =>
      agent(
        `Модуль ${P}/${mod}. Прочитай все файлы. Ищи ошибки ЛОГИКИ, не стиль:
неверные сравнения (строка vs enum, == vs ===, null vs undefined), недостающие/удалённые гарды, неучтённые ветки и статусы,
ошибки границ (off-by-one, пустые массивы, пагинация), неправильная обработка ошибок (проглоченные исключения, неверные коды ответа),
гонки и незавершённые транзакции, мёртвый или недостижимый код с последствиями, расхождение типа и рантайма.
Мнение "я бы сделал иначе" — не находка. spec_ref = "нет спеки".
${RULES}`,
        { schema: FINDINGS, agentType: 'reviewer-deep', phase: 'DEEP', label: `deep:${mod}` },
      ),
    ),
  )
  for (const r of deep.filter(Boolean)) raw.push(...tag('deep', r.findings))
  log(`DEEP: ${raw.filter((f) => f.kind === 'deep').length} находок`)
}

// дедуп по файлу+строке (одну проблему могли поднять IR и DEEP)
const seen = new Set()
const unique = raw.filter((f) => {
  const k = `${f.file}:${f.line}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
log(`Всего ${raw.length} сырых, ${unique.length} после дедупа, токены ${spentK()}k`)

let confirmed = unique
let refutedCount = 0
if (unique.length && canRun('VERIFY', 150_000)) {
  phase('VERIFY')
  const verdicts = await parallel(
    unique.map((f) => () =>
      agent(
        `Опровергни находку. Открой ${P}/${f.file} около строки ${f.line} и связанный код; при spec_ref не "нет спеки" открой спеку в ${D}.
Находка: ${f.title}
Разбор: ${f.analysis}
Причина: ${f.cause}
Спека: ${f.spec_ref}
refuted=true если: код так не делает; поведение намеренное и покрыто спекой/тестом; спека прочитана неверно; проблема не воспроизводима.
При сомнении refuted=true. reason — одна строка по коду.`,
        { schema: VERDICT, agentType: 'reviewer-deep', phase: 'VERIFY', label: `verify:${f.file.split('/').pop()}:${f.line}`, effort: 'high' },
      ),
    ),
  )
  confirmed = unique.filter((f, i) => verdicts[i] && !verdicts[i].refuted)
  refutedCount = unique.length - confirmed.length
  log(`VERIFY: подтверждено ${confirmed.length}, опровергнуто ${refutedCount}`)
} else if (unique.length) {
  log('VERIFY пропущена — карточки пойдут как НЕПРОВЕРЕННЫЕ')
}

phase('WRITE')
const order = { high: 0, medium: 1, low: 2 }
confirmed.sort((a, b) => order[a.severity] - order[b.severity])
const verified = !skipped.includes('VERIFY')
const CHUNK = 12
const header = `## Discover — ${cfg.runAt || '$(date +%Y-%m-%d)'} (на разбор)

Baseline: lint ${baseline ? baseline.lint : '?'} ошибок, tests ${baseline ? `${baseline.passed} passed / ${baseline.failed} failed${baseline.runnable ? '' : ' (не запускаются)'}` : '?'}.
Прогон: ${raw.length} сырых → ${unique.length} уникальных → ${confirmed.length} ${verified ? 'подтверждено' : 'НЕ ПРОВЕРЕНО'}${refutedCount ? `, ${refutedCount} опровергнуто` : ''}. Токены ~${spentK()}k.${skipped.length ? ` Пропущено: ${skipped.join(', ')}.` : ''}
Разметка: поставь в карточке **Решение:** \`в работу\` (можно "в работу, вариант 2"), \`отклонить\` или \`позже\`. forge берёт только \`в работу\`, сверху вниз.`

await agent(
  `Через Read+Edit добавь в ${cfg.stateFile} новый раздел СРАЗУ ПОСЛЕ секции "## High Priority" (перед "## Watch"). Ничего существующего не удаляй и не переформулируй.
Текст раздела (дату подставь реальную через shell date, если в заголовке $(date ...)):
${header}

Под ним пустая строка. Карточки допишут следующие шаги.`,
  { agentType: 'coder', phase: 'WRITE', label: 'write:header', effort: 'low' },
)

for (let i = 0; i < confirmed.length; i += CHUNK) {
  const chunk = confirmed.slice(i, i + CHUNK)
  await agent(
    `Через Read+Edit допиши в ${cfg.stateFile} в конец раздела "## Discover — …" (перед следующим "## " заголовком) карточки.
Нумерация D-NNN сквозная: найди максимальный D-NNN во всём файле и продолжай с него (если нет — с D-001).
Формат КАЖДОЙ карточки (строго, человек читает это глазами):

### D-NNN · <title>  ·  <kind> · <severity>
- **Где:** \`<file>:<line>\`
- **Код:**
  \`\`\`ts
  <code>
  \`\`\`
- **Разбор:** <analysis>
- **Причина:** <cause>
- **Спека:** <spec_ref>
- **Варианты исправления:**
  1. <fix_options[0]>
  2. <fix_options[1]>
  ...
- **Готово, когда:** <done_criterion>
- **Решение:** _

Данные карточек (JSON):
${JSON.stringify(chunk)}`,
    { agentType: 'coder', phase: 'WRITE', label: `write:${i / CHUNK + 1}`, effort: 'low' },
  )
}

if (notImpl.length) {
  await agent(
    `Через Read+Edit допиши в ${cfg.stateFile} в конец раздела "## Discover — …" (перед следующим "## " заголовком) подраздел:

### Не реализовано (по спекам; не ошибки, в forge не идёт)
${[...new Set(notImpl)].map((s) => `- ${s}`).join('\n')}`,
    { agentType: 'coder', phase: 'WRITE', label: 'write:not-implemented', effort: 'low' },
  )
}

await agent(
  `cd ${P}. Допиши В КОНЕЦ ${P}/.agent-loop/run-log.md (создай если нет) запись:
## $(date '+%Y-%m-%d %H:%M') — прогон forge-discover
- baseline: lint ${baseline ? baseline.lint : '?'}, tests ${baseline ? `${baseline.passed}/${baseline.failed}` : '?'}
- находок: ${raw.length} сырых, ${unique.length} уникальных, ${confirmed.length} в STATE.md, опровергнуто ${refutedCount}, не реализовано ${new Set(notImpl).size}
- токены: ~${spentK()}k из ${Math.round(cfg.maxTokens / 1000)}k${skipped.length ? `; пропущено: ${skipped.join(', ')}` : ''}
Дату подставь реальную через shell date.`,
  { agentType: 'coder', phase: 'WRITE', label: 'run-log', effort: 'low' },
)

return {
  baseline,
  raw: raw.length,
  unique: unique.length,
  confirmed: confirmed.length,
  refuted: refutedCount,
  notImplemented: new Set(notImpl).size,
  skipped,
  tokensK: spentK(),
  byKind: ['mech', 'ir', 'behavior', 'deep'].map((k) => `${k}:${confirmed.filter((f) => f.kind === k).length}`).join(' '),
}
