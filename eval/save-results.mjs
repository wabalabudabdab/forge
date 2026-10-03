#!/usr/bin/env node
// Usage: node eval/save-results.mjs < workflow-result.json > eval/results/<run>.jsonl
import { readFileSync } from 'node:fs'
const { records } = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(records.map((r) => JSON.stringify(r)).join('\n') + '\n')
