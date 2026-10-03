#!/usr/bin/env node
// Usage: node eval/save-results.mjs < workflow-output.json > eval/results/<run>.jsonl
// Accepts either the script's return value ({ records }) or the Workflow output file ({ result: { records } }).
import { readFileSync } from 'node:fs'
const data = JSON.parse(readFileSync(0, 'utf8'))
const { records } = data.result || data
process.stdout.write(records.map((r) => JSON.stringify(r)).join('\n') + '\n')
