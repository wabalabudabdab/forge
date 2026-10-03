import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mutate, OPERATORS } from '../lib/mutate.mjs'

const DIFF = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,5 +1,7 @@
 function clamp(x, lo, hi) {
-  if (x < lo) return lo
+  if (x < lo) return lo
+  if (x > hi && hi !== null) return hi
   return x
 }
+const ok = count >= 1
`

test('same seed gives identical output and metadata', () => {
  const a = mutate(DIFF, 42)
  const b = mutate(DIFF, 42)
  assert.ok(a)
  assert.deepEqual(a, b)
})

test('different seeds can choose different sites', () => {
  const outs = new Set()
  for (let s = 0; s < 40; s++) outs.add(mutate(DIFF, s).diff)
  assert.ok(outs.size > 1)
})

test('only added lines change', () => {
  for (let s = 0; s < 40; s++) {
    const m = mutate(DIFF, s)
    const before = DIFF.split('\n')
    const after = m.diff.split('\n')
    assert.equal(after.length, before.length)
    const changed = before.map((l, i) => (l !== after[i] ? i : -1)).filter((i) => i >= 0)
    assert.equal(changed.length, 1, `seed ${s}`)
    const line = before[changed[0]]
    assert.ok(line.startsWith('+') && !line.startsWith('+++'), `seed ${s} changed: ${line}`)
    assert.equal(m.line, changed[0] + 1)
    assert.equal(m.original, line)
    assert.equal(m.mutated, after[changed[0]])
    assert.ok(OPERATORS.includes(m.operator))
  }
})

test('removed and context lines are never mutated', () => {
  const diff = `--- a/x.js
+++ b/x.js
@@ -1,3 +1,3 @@
 if (a < b) return 1
-if (c > d) return 2
+// comment only
`
  assert.equal(mutate(diff, 1), null)
})

test('returns null when no operator applies', () => {
  assert.equal(mutate('--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+hello world\n', 3), null)
})

test('each operator produces the expected rewrite', () => {
  const one = (code, op) => {
    const d = `--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+${code}\n`
    for (let s = 0; s < 200; s++) {
      const m = mutate(d, s)
      if (m && m.operator === op) return m.mutated.slice(1)
    }
    return null
  }
  assert.equal(one('if (a === b) go()', 'comparison-flip'), 'if (a !== b) go()')
  assert.equal(one('if (i < n) go()', 'boundary-shift'), 'if (i <= n) go()')
  assert.equal(one('if (ready) go()', 'condition-negate'), 'if (!(ready)) go()')
  assert.equal(one('if (a && b) go()', 'logical-swap'), 'if (a || b) go()')
  assert.equal(one('  if (!user) return null', 'guard-remove'), '  if (false) return null')
})
