#!/usr/bin/env node
// Usage: node eval/make-args.mjs <items.jsonl> [reps] > args.json
// Builds the Workflow args for review-eval.workflow.js from a corpus and the committed prompts.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [file, reps = '3'] = process.argv.slice(2)
const items = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  const x = JSON.parse(l)
  return { id: x.id, kind: x.kind, operator: x.operator, message: x.message, diff: x.diff }
})
const prompts = Object.fromEntries(['generic', 'rereview', 'logical', 'deep'].map((k) => [k, readFileSync(join(here, 'prompts', `${k}.md`), 'utf8')]))
process.stdout.write(JSON.stringify({ items, prompts, reps: Number(reps) }))
