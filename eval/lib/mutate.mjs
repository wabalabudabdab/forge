// Seeded single-site mutator for unified diffs. Only lines added by the diff are mutated,
// so the injected defect is always inside the change a reviewer is asked to judge.

export const OPERATORS = ['comparison-flip', 'boundary-shift', 'condition-negate', 'logical-swap', 'guard-remove']

const FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' }
const SHIFT = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' }
const SWAP = { '&&': '||', '||': '&&' }

// mulberry32: small, fast, and identical across Node versions
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// index of the ")" matching the "(" at `open`, or -1
function closeParen(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i
  }
  return -1
}

function sites(code) {
  const out = []
  const add = (operator, start, end, text) => out.push({ operator, start, end, text })

  for (const m of code.matchAll(/(?<![=!<>])(!==|===|!=|==)(?!=)/g)) add('comparison-flip', m.index, m.index + m[1].length, FLIP[m[1]])
  for (const m of code.matchAll(/(?<= )(<=|>=|<|>)(?= )/g)) add('boundary-shift', m.index, m.index + m[1].length, SHIFT[m[1]])
  for (const m of code.matchAll(/(?<= )(&&|\|\|)(?= )/g)) add('logical-swap', m.index, m.index + 2, SWAP[m[1]])

  for (const m of code.matchAll(/\b(if|while)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const close = closeParen(code, open)
    if (close < 0) continue
    const cond = code.slice(open + 1, close)
    add('condition-negate', open + 1, close, `!(${cond})`)
    if (m[1] === 'if' && /^\s*(return|throw)\b/.test(code.slice(close + 1))) add('guard-remove', open + 1, close, 'false')
  }
  return out
}

export function mutate(diff, seed) {
  const lines = diff.split('\n')
  const candidates = []
  lines.forEach((line, i) => {
    if (!line.startsWith('+') || line.startsWith('+++')) return
    const code = line.slice(1)
    if (/^\s*(\/\/|\/\*|\*|#)/.test(code)) return
    for (const s of sites(code)) candidates.push({ i, ...s })
  })
  if (candidates.length === 0) return null

  const pick = candidates[Math.floor(rng(seed)() * candidates.length)]
  const code = lines[pick.i].slice(1)
  const mutatedLine = '+' + code.slice(0, pick.start) + pick.text + code.slice(pick.end)
  const original = lines[pick.i]
  lines[pick.i] = mutatedLine
  return { diff: lines.join('\n'), operator: pick.operator, line: pick.i + 1, original, mutated: mutatedLine }
}
