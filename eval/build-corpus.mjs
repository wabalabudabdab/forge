#!/usr/bin/env node
// Builds the review corpus from a public repository's history.
//
// For each small commit C: the clean item is C's change to source files; the buggy item is the same
// change with one seeded mutation. A pair is kept only if the project's tests pass on C and fail with
// the mutation applied, so every buggy item is a regression by the project's own oracle.
//
// Usage:
//   node eval/build-corpus.mjs --repo <local clone> --test "<test command>" \
//     --src '^src/' --tests '(^test/|\.test\.)' --want 30 --scan 400 --out eval/corpus
//
// The clone must already have dependencies installed; they are reused for every commit, so keep
// --scan to a window where dependencies did not change.

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mutate } from './lib/mutate.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const REPO = resolve(arg('repo', ''))
const TEST = arg('test', 'npm test')
const SRC = new RegExp(arg('src', '^src/'))
const TESTS = new RegExp(arg('tests', '(^test/|\\.test\\.|\\.spec\\.)'))
const WANT = Number(arg('want', '30'))
const SCAN = Number(arg('scan', '400'))
const MAX_ADDED = Number(arg('maxAdded', '60'))
const SEEDS = Number(arg('seeds', '6'))
const OUT = resolve(arg('out', 'eval/corpus'))
if (!existsSync(join(REPO, '.git'))) throw new Error(`--repo must be a git clone: ${REPO}`)

const sh = (cmd, cwd = REPO) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
const passes = (cwd) => {
  try {
    execSync(TEST, { cwd, stdio: 'ignore', timeout: 300_000 })
    return true
  } catch {
    return false
  }
}

// split a unified diff into per-file chunks keyed by the new path
function splitDiff(diff) {
  return diff.split(/^(?=diff --git )/m).filter(Boolean).map((chunk) => {
    const m = chunk.match(/^\+\+\+ b\/(.+)$/m)
    return { path: m ? m[1] : null, chunk }
  })
}
const added = (chunk) => chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length

mkdirSync(OUT, { recursive: true })
const ITEMS = join(OUT, 'items.jsonl')
const LOG = join(OUT, 'build-log.jsonl')
writeFileSync(ITEMS, '')
writeFileSync(LOG, '')
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + '\n')

const WT = join(tmpdir(), `forge-eval-wt-${process.pid}`)
sh(`git worktree add --detach ${WT} HEAD`)
if (existsSync(join(REPO, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(WT, 'node_modules'))

let kept = 0
try {
  const commits = sh(`git rev-list --no-merges --max-count=${SCAN} HEAD`).trim().split('\n')
  for (const c of commits) {
    if (kept >= WANT) break
    const files = splitDiff(sh(`git diff ${c}^ ${c}`))
    const src = files.filter((f) => f.path && SRC.test(f.path) && !TESTS.test(f.path))
    if (src.length === 0 || src.length > 3) { log({ commit: c, skip: 'source-file count' }); continue }
    const srcDiff = src.map((f) => f.chunk).join('')
    if (added(srcDiff) > MAX_ADDED) { log({ commit: c, skip: 'too large' }); continue }

    sh(`git checkout -q --force ${c}`, WT)
    if (!passes(WT)) { log({ commit: c, skip: 'clean tests fail' }); continue }

    let found = null
    for (let seed = 0; seed < SEEDS && !found; seed++) {
      const m = mutate(srcDiff, seed)
      if (!m) break
      // apply only the mutated line on top of C: reverse the clean source diff, apply the mutated one
      writeFileSync(join(WT, '.clean.diff'), srcDiff)
      writeFileSync(join(WT, '.mut.diff'), m.diff)
      try {
        sh('git apply -R .clean.diff && git apply .mut.diff', WT)
      } catch {
        log({ commit: c, seed, skip: 'mutant does not apply' })
        sh(`git checkout -q --force ${c}`, WT)
        continue
      }
      const killed = !passes(WT)
      log({ commit: c, seed, operator: m.operator, result: killed ? 'killed' : 'survived' })
      sh(`git checkout -q --force ${c}`, WT)
      rmSync(join(WT, '.clean.diff'), { force: true })
      rmSync(join(WT, '.mut.diff'), { force: true })
      if (killed) found = { seed, ...m }
    }
    if (!found) continue

    const message = sh(`git log -1 --format=%B ${c}`).trim()
    const base = { commit: c, message }
    appendFileSync(ITEMS, JSON.stringify({ id: `${c.slice(0, 8)}-clean`, kind: 'clean', operator: null, diff: srcDiff, ...base }) + '\n')
    appendFileSync(ITEMS, JSON.stringify({ id: `${c.slice(0, 8)}-buggy`, kind: 'buggy', operator: found.operator, seed: found.seed, line: found.line, diff: found.diff, ...base }) + '\n')
    kept++
    console.log(`kept ${kept}/${WANT}: ${c.slice(0, 8)} ${found.operator}`)
  }
} finally {
  sh(`git worktree remove --force ${WT}`)
}
console.log(`done: ${kept} pairs → ${ITEMS}`)
