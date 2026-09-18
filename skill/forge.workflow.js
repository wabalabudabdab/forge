// forge — переиспользуемый агентский цикл «доведи и улучши проект».
// Один проход = одна задача из очереди: BUILD → GATE → REVIEW → INTEGRATE+CLEANUP → RECORD.
// Внешний loop идёт по очереди, пока есть задачи и не исчерпан бюджет.
//
// Запуск: Workflow({ scriptPath: ".../forge.workflow.js", args: { ...cfg } })
// args (всё опционально, есть дефолты под ваш проект):
//   projectPath  — путь к git-репо проекта
//   baseBranch   — базовая ветка (мёрджим сюда)
//   maxTasks     — сколько задач взять за прогон (страховка)
//   gates        — { lint, build, test }  shell-команды ворот (test может требовать БД)
//   baseline     — { testsPassed, lintErrors } для критерия NO-REGRESSION
//   maxAttempts  — попыток на задачу (по всем прогонам); после — задача уходит в BLOCKED, цикл идёт дальше
//   maxTokens    — потолок output-токенов на прогон (свой, не зависит от «+500k»)
//   denylist     — пути, которые цикл не имеет права менять (проверяется механически по git diff --name-only)
//
//   stateFile    — STATE.md проекта: очередь = карточки D-NNN с "**Решение:** в работу" (пишет forge-discover, размечает человек)
//
// Состояние между прогонами:
//   STATE.md (stateFile)      — очередь/итоги для человека; строка "Pause: да" = kill switch
//   .agent-loop/state.md      — таблица | id | attempts | status | last_issues |  (память попыток)
//   .agent-loop/baseline.json — baseline от discover, если args.baseline не передан
//   .agent-loop/journal.md    — подробности по задачам
//   .agent-loop/run-log.md    — append-only, одна запись на прогон
//
// Уроки обкатки (зашиты, не трогать без причины):
//   1. дифф подаётся ревьюеру артефактом-файлом (read-only агенты без Bash)
//   2. BUILD не делает слепой git add -A — откатывает env перед коммитом + самопроверка
//   3. дифф-артефакт ВСЕГДА rm перед генерацией (stale = ложный вердикт)
//   4. INTEGRATE убирает за собой ветку (самоуборка) и проверяет отсутствие .env в коммите
//   5. (loop-engineering) лимит попыток + BLOCKED, denylist по diff, потолок токенов, run-log, Pause в STATE.md

export const meta = {
  name: 'forge',
  description: 'Агентский цикл: берёт задачи из очереди проекта и доводит каждую до мёрджа через ворота и ревью, с самоуборкой',
  phases: [
    { title: 'SELECT' },
    { title: 'BUILD' },
    { title: 'GATE' },
    { title: 'REVIEW' },
    { title: 'INTEGRATE' },
  ],
}

const cfg = {
  projectPath: '/path/to/your-project',
  stateFile: '/path/to/your-project/STATE.md',
  baseBranch: 'main',
  maxTasks: 3,
  gates: {
    lint: 'bun run lint',
    build: 'bun run build',
    test: 'bun run test',
  },
  baseline: null,
  maxAttempts: 3,
  maxTokens: 600_000,
  denylist: ['.env', '.pem', '.key', '.gitlab-ci.yml', 'docker-compose', 'Dockerfile', '/auth/'],
  ...(args || {}),
}

const P = cfg.projectPath
const S = cfg.stateFile
const BASELINE = cfg.baseline
  ? `tests ${cfg.baseline.testsPassed} passed, lint ${cfg.baseline.lintErrors} errors`
  : `прочитай ${P}/.agent-loop/baseline.json (testsPassed, lintErrors); если файла нет — regression считай только по build_ok=false и tests_failed>0`

const TASK_SCHEMA = {
  type: 'object',
  required: ['id', 'has_task', 'scope', 'done_criterion', 'attempts', 'last_issues', 'reason'],
  properties: {
    id: { type: 'string' },
    has_task: { type: 'boolean' },
    scope: { type: 'string' },
    done_criterion: { type: 'string' },
    attempts: { type: 'integer' },
    last_issues: { type: 'string' },
    reason: { type: 'string' },
  },
}
const DIFF_SCHEMA = {
  type: 'object',
  required: ['files', 'violations'],
  properties: { files: { type: 'integer' }, violations: { type: 'array', items: { type: 'string' } } },
}
const GATE_SCHEMA = {
  type: 'object',
  required: ['lint_errors', 'build_ok', 'tests_passed', 'tests_failed', 'regression', 'notes'],
  properties: {
    lint_errors: { type: 'integer' },
    build_ok: { type: 'boolean' },
    tests_passed: { type: 'integer' },
    tests_failed: { type: 'integer' },
    regression: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approved', 'issues'],
  properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
}
const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['merged', 'branch_deleted', 'notes'],
  properties: { merged: { type: 'boolean' }, branch_deleted: { type: 'boolean' }, notes: { type: 'string' } },
}

const results = []
const DENY = cfg.denylist.join(', ')
const tokensAtStart = budget.spent()
const tokensLeft = () => cfg.maxTokens - (budget.spent() - tokensAtStart)
let stopReason = 'очередь пуста'

for (let i = 0; i < cfg.maxTasks; i++) {
  if (tokensLeft() < 60_000 || (budget.total && budget.remaining() < 60_000)) {
    stopReason = `потолок токенов (${Math.round((budget.spent() - tokensAtStart) / 1000)}k из ${Math.round(cfg.maxTokens / 1000)}k)`
    log(`Бюджет на исходе — останавливаю цикл: ${stopReason}`)
    break
  }

  phase('SELECT')
  const task = await agent(
    `Работай через Read/Edit.
0. Прочитай ${S}. Если в шапке "Pause: да" — kill switch: has_task=false, reason="PAUSE".
1. Очередь = карточки "### D-NNN · …" в разделах "## Discover — …", у которых строка "**Решение:** в работу" (допускается уточнение после запятой, напр. "в работу, вариант 2"). Порядок — сверху вниз по файлу.
2. Прочитай ${P}/.agent-loop/state.md (если нет — создай с таблицей "| id | attempts | status | last_issues |"). Для верхней карточки: attempts (0 если строки нет), last_issues.
   Если attempts >= ${cfg.maxAttempts} — в карточке замени "**Решение:** в работу…" на "**Решение:** blocked (лимит попыток, ветка forge/<id> оставлена)", в state.md status=blocked, и возьми СЛЕДУЮЩУЮ. Повторяй пока не найдёшь допустимую.
3. Нет ни одной — has_task=false, reason="empty".
Верни: id (D-NNN), has_task, scope = title + "Разбор" + выбранный вариант исправления (если человек указал вариант — именно он, иначе вариант 1) + "Где", done_criterion = "Готово, когда", attempts, last_issues, reason.`,
    { schema: TASK_SCHEMA, agentType: 'coder', phase: 'SELECT' },
  )
  if (!task || !task.has_task) {
    stopReason = task && task.reason === 'PAUSE' ? 'PAUSE (kill switch)' : 'очередь пуста'
    log(`Цикл завершён: ${stopReason}`)
    break
  }

  const BR = `forge/${task.id.toLowerCase()}`
  const attempt = (task.attempts || 0) + 1
  log(`▶ ${task.id} (попытка ${attempt}/${cfg.maxAttempts}): ${task.scope}`)
  const tokensAtTask = budget.spent()

  phase('BUILD')
  const build = await agent(
    `cd ${P} (git-репо). Реши задачу ${task.id}: ${task.scope}
Критерий готовности: ${task.done_criterion}
${task.last_issues ? `Это попытка ${attempt}. Прошлая попытка отклонена: ${task.last_issues}. Учти это.` : ''}
Шаги:
1. git checkout ${cfg.baseBranch}; git branch -D ${BR} 2>/dev/null; git checkout -b ${BR}
2. Реализуй задачу. Меняй ТОЛЬКО то, что относится к задаче. НЕ трогай бизнес-логику сверх необходимого.
   ЗАПРЕЩЁННЫЕ пути (denylist, мёрдж будет отклонён механически): ${DENY}. Если задача без них невыполнима — не делай её, опиши в summary.
3. Защита от грязи: git checkout -- '**/.env*' 2>/dev/null; true  (env не коммитим)
4. git add -A && git commit -m "${task.id}: ${task.scope}"
5. Самопроверка: git show --stat HEAD НЕ должен содержать .env* файлов.
Верни краткий summary текстом.`,
    { agentType: 'coder', phase: 'BUILD' },
  )

  phase('GATE')
  const gate = await agent(
    `cd ${P} && git checkout ${BR}. Прогони ворота, верни числа:
- lint_errors: "${cfg.gates.lint}" → число после "Found N errors" (0 если нет)
- build_ok: "${cfg.gates.build}" → exit 0?
- tests_passed / tests_failed: "${cfg.gates.test}" → "N passed / M failed"
Baseline: ${BASELINE}.
regression = true ЕСЛИ (tests_passed < baseline.testsPassed) ИЛИ (build_ok=false) ИЛИ (lint_errors > baseline.lintErrors). Иначе false. В notes укажи, какой baseline использован.`,
    { schema: GATE_SCHEMA, agentType: 'coder', phase: 'GATE' },
  )

  let reviews = []
  let integrate = { merged: false, branch_deleted: false, notes: '' }
  let issues = ''

  if (gate.regression) {
    issues = `GATE regression: tests ${gate.tests_passed}/${gate.tests_failed}, build ${gate.build_ok}, lint ${gate.lint_errors}. ${gate.notes}`
    integrate.notes = `GATE regression — ветка ${BR} оставлена для разбора`
    log(`✗ ${task.id}: ${issues}`)
  } else {
    // дифф-артефакт: ВСЕГДА rm старого перед генерацией (урок 3) + механическая проверка denylist
    const diff = await agent(
      `cd ${P} && rm -f .agent-loop/${task.id}.diff .agent-loop/${task.id}.stat && git diff ${cfg.baseBranch}..${BR} > .agent-loop/${task.id}.diff && git diff --stat ${cfg.baseBranch}..${BR} > .agent-loop/${task.id}.stat && git diff --name-only ${cfg.baseBranch}..${BR}
Сначала rm старых файлов. files = число файлов из --name-only.
violations = те пути из --name-only, которые содержат любую подстроку из denylist: ${DENY}. Пустой массив если нет.`,
      { schema: DIFF_SCHEMA, agentType: 'coder', phase: 'REVIEW', label: `diff:${task.id}` },
    )
    if (diff && diff.violations.length) {
      issues = `denylist: ${diff.violations.join(', ')}`
      integrate.notes = `denylist нарушен — ветка ${BR} оставлена`
      log(`✗ ${task.id}: ${issues}`)
    } else {
      phase('REVIEW')
      reviews = await parallel([
        () =>
          agent(
            `Прочитай через Read СВЕЖИЙ дифф ${P}/.agent-loop/${task.id}.diff и ${P}/.agent-loop/${task.id}.stat (большой — частями).
  Задача ${task.id}: ${task.scope}. Критерий: ${task.done_criterion}.
  Совпадает ли дифф с намерением? Проверь: НЕТ ли в диффе .env-файлов (заголовки "diff --git" с .env).
  approved=false при изменении логики сверх задачи или наличии env/секретов. issues — список (пусто если ок).`,
            { schema: REVIEW_SCHEMA, agentType: 'reviewer-logical', phase: 'REVIEW' },
          ),
        () =>
          agent(
            `Прочитай через Read СВЕЖИЙ дифф ${P}/.agent-loop/${task.id}.diff (частями).
  Ищи скрытые поломки: изменённое поведение под видом рефактора, удалённые гарды/проверки, сломанные типы.
  approved=false при обоснованном подозрении. issues — список.`,
            { schema: REVIEW_SCHEMA, agentType: 'reviewer-deep', phase: 'REVIEW' },
          ),
      ])
      const ok = reviews.filter(Boolean).every((r) => r.approved)
      if (ok) {
        phase('INTEGRATE')
        integrate = await agent(
          `cd ${P}. Перед мёрджем: git show --stat ${BR} НЕ должен содержать .env* (если есть — merged=false, СТОП).
  Иначе: git checkout ${cfg.baseBranch}; git merge --no-ff ${BR} -m "merge ${task.id}"; git branch -d ${BR}
  Верни merged, branch_deleted, notes. Подтверди, что "git branch" больше НЕ показывает ${BR}.`,
          { schema: INTEGRATE_SCHEMA, agentType: 'coder', phase: 'INTEGRATE' },
        )
      } else {
        issues = `REVIEW: ${reviews.filter(Boolean).flatMap((r) => r.issues).join('; ')}`
        integrate.notes = `REVIEW отклонил — ветка ${BR} оставлена`
        log(`✗ ${task.id}: ${issues}`)
      }
    }
  }

  const blocked = !integrate.merged && attempt >= cfg.maxAttempts
  const taskTokens = Math.round((budget.spent() - tokensAtTask) / 1000)

  // RECORD: журнал + state (попытки) + очередь
  await agent(
    `cd ${P}. Работай через Read+Edit.
1. Допиши в ${P}/.agent-loop/journal.md запись по ${task.id} (попытка ${attempt}):
- gate: lint ${gate.lint_errors}, build ${gate.build_ok}, tests ${gate.tests_passed}/${gate.tests_failed}, regression ${gate.regression}
- итог: ${integrate.merged ? 'MERGED + ветка удалена' : 'НЕ влито (' + integrate.notes + ')'}
- токены: ~${taskTokens}k
2. В ${P}/.agent-loop/state.md обнови/добавь строку ${task.id}: attempts=${attempt}, status=${integrate.merged ? 'done' : blocked ? 'blocked' : 'retry'}, last_issues="${(issues || '').replace(/"/g, "'").slice(0, 300)}".
3. В ${S}: ${integrate.merged ? `в карточке ${task.id} замени строку "**Решение:** …" на "**Решение:** done (forge, влито в ${cfg.baseBranch})" и добавь одну строку в "## Done (недавно)": "- ${task.id}: ${task.scope.split('.')[0].slice(0, 90)} — forge".` : blocked ? `в карточке ${task.id} замени строку "**Решение:** …" на "**Решение:** blocked (${cfg.maxAttempts} попыток, ветка ${BR}: ${(issues || '').replace(/"/g, "'").slice(0, 120)})" и добавь строку в "## Blocked": "- ${task.id}: forge не справился за ${cfg.maxAttempts} попытки, ветка ${BR}".` : 'ничего не меняй.'}`,
    { agentType: 'coder', phase: 'INTEGRATE', label: `record:${task.id}` },
  )

  results.push({ task: task.id, attempt, gate, merged: integrate.merged, blocked, issues, tokensK: taskTokens })
  if (blocked) log(`⛔ ${task.id}: BLOCKED после ${attempt} попыток — нужен человек; цикл идёт дальше`)
  else if (!integrate.merged) log(`↻ ${task.id}: попытка ${attempt} не прошла, следующий проход возьмёт её снова с учётом замечаний`)
}

const totalK = Math.round((budget.spent() - tokensAtStart) / 1000)
await agent(
  `cd ${P}. Допиши В КОНЕЦ ${P}/.agent-loop/run-log.md (создай если нет; ничего не удаляй) одну запись:
## $(date '+%Y-%m-%d %H:%M') — прогон forge
- задач: ${results.length}, влито: ${results.filter((r) => r.merged).length}, retry: ${results.filter((r) => !r.merged && !r.blocked).length}, blocked: ${results.filter((r) => r.blocked).length}
- токены: ~${totalK}k из ${Math.round(cfg.maxTokens / 1000)}k
- стоп: ${stopReason}
- по задачам: ${results.map((r) => `${r.task}#${r.attempt}=${r.merged ? 'merged' : r.blocked ? 'BLOCKED' : 'retry'}`).join(', ') || 'нет'}
Дату подставь реальную через shell date.`,
  { agentType: 'coder', phase: 'INTEGRATE', label: 'run-log', effort: 'low' },
)

return { ran: results.length, merged: results.filter((r) => r.merged).length, blocked: results.filter((r) => r.blocked).map((r) => r.task), tokensK: totalK, stopReason, results }
