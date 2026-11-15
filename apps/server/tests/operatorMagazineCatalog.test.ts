// The Stable Hand's MAGAZINE catalog and rules, held to the web actions and to
// the audit fixes they carry.
//
// tests/operatorCatalog.test.ts pins action NAMES in both directions. Nothing pins
// their ARGUMENTS, and that is where the magazine pack drifted: the catalog told
// the model to attach a PDF through the studio composer while copyPdfPage had no
// way to take it, and an action that gains an argument on the web (attachment,
// doc) is invisible to the model until the catalog says so. These tests compare
// each magazine action's top-level argument names and optionality with the zod
// object the web registers, and guard the prompt rules the audit added (verify a
// page with magazine.checkPage, charts from numbers through magazine.addChart,
// word swaps through magazine.replaceText, PDFs for copyPdfPage via attachment).
//
// Pure file reads + in-memory rendering. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SURFACES } from '../src/lib/agent/operator/catalog/magazine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WEB_OPERATOR = path.resolve(here, '../../web/src/editor-v2/operator')
const WEB_FILES = ['useMagazineHomeActions.ts', 'useMagazineEditorActions.ts', 'useMagazineDangerActions.ts']

// Same as operatorCatalog.test.ts: prompt.ts reaches lib/db.ts, which throws at
// import without a MONGODB_URI; the client connects lazily and nothing queries.
function loadPromptModule() {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/operator-catalog-test-never-connects'
  return import('../src/lib/agent/operator/prompt.js')
}

// ── a tiny scanner for object literals in source text ───────────────────────

/** Index of the bracket that closes the one at `open`, skipping strings and comments. */
function matchBracket(src: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return -1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
      if (i <= 0) return -1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++
      continue
    }
    if (pairs[ch]) stack.push(pairs[ch]!)
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Split the inside of a bracket pair at top-level separators (strings, comments and nesting respected). */
function splitTopLevel(body: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i)
      i = nl < 0 ? body.length : nl
      continue
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2)
      i = end < 0 ? body.length : end + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < body.length && body[i] !== ch; i++) if (body[i] === '\\') i++
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++
    else if (ch === '}' || ch === ')' || ch === ']') depth--
    else if (ch === sep && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts.map((p) => p.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()).filter(Boolean)
}

/** Drop the inside of every (...) group, so only a key's own method chain is left:
 *  'z.object({ a: z.string().optional() })' → 'z.object()'. A placeholder stands in
 *  for a flattened group while outer groups are still being found. */
function flattenCalls(s: string): string {
  const HOLE = '\u0001'
  let prev = ''
  let out = s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''")
  while (out !== prev) {
    prev = out
    out = out.replace(/\([^()]*\)/g, HOLE)
  }
  return out.split(HOLE).join('()')
}

type ArgShape = Map<string, { optional: boolean }>

/** Top-level keys of a catalog args signature: '{ page?: number; doc?: string }'. */
function catalogArgs(sig: string): ArgShape {
  const shape: ArgShape = new Map()
  const trimmed = sig.trim()
  const close = matchBracket(trimmed, 0)
  assert.ok(trimmed.startsWith('{') && close === trimmed.length - 1, `catalog args is not one object signature: ${sig}`)
  for (const part of splitTopLevel(trimmed.slice(1, -1), ';')) {
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:/.exec(part)
    assert.ok(m, `catalog args: cannot read the key in "${part}" of ${sig}`)
    shape.set(m[1]!, { optional: m[2] === '?' })
  }
  return shape
}

/** Top-level keys of the web action's args: z.object({ ... }), keyed by action name. */
function webArgs(): Map<string, { shape: ArgShape; file: string }> {
  const out = new Map<string, { shape: ArgShape; file: string }>()
  for (const file of WEB_FILES) {
    const src = fs.readFileSync(path.join(WEB_OPERATOR, file), 'utf8')
    const names = [...src.matchAll(/\bname:\s*'(magazine\.[A-Za-z]+)'/g)]
    names.forEach((m, k) => {
      const from = m.index! + m[0].length
      const until = k + 1 < names.length ? names[k + 1]!.index! : src.length
      const at = src.slice(from, until).search(/\bargs:\s*z\.object\(\s*\{/)
      assert.ok(at >= 0, `${file}: ${m[1]} has no inline "args: z.object({ … })" — teach this test its form`)
      const open = src.indexOf('{', from + at)
      const close = matchBracket(src, open)
      assert.ok(close > open, `${file}: ${m[1]} args object does not close`)
      const shape: ArgShape = new Map()
      for (const part of splitTopLevel(src.slice(open + 1, close), ',')) {
        const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(part)
        assert.ok(key, `${file}: ${m[1]}: cannot read the key in "${part.slice(0, 80)}" (a spread or computed key?)`)
        const chain = flattenCalls(part.slice(key[0].length))
        shape.set(key[1]!, { optional: /\.(?:optional|default|nullish)\(\)/.test(chain) })
      }
      out.set(m[1]!, { shape, file })
    })
  }
  return out
}

const describeShape = (s: ArgShape) =>
  [...s.entries()]
    .map(([k, v]) => `${k}${v.optional ? '?' : ''}`)
    .sort()
    .join(', ') || '(none)'

const actions = SURFACES.flatMap((s) => s.actions)
const action = (name: string) => {
  const a = actions.find((x) => x.name === name)
  assert.ok(a, `${name} is missing from the magazine catalog`)
  return a
}

// ── tests ───────────────────────────────────────────────────────────────────

test('the scanners read both kinds of signature (guards the scanners themselves)', () => {
  assert.equal(describeShape(catalogArgs('{}')), '(none)')
  assert.equal(
    describeShape(catalogArgs("{ page?: number; chart: { type: 'bar'|'pie'; title?, source?: string }; replace?: string /* an id; with: semicolons */ }")),
    'chart, page?, replace?',
  )
  // A nested .optional() must not make a required key look optional.
  assert.equal(flattenCalls("z.object({ prefix: z.string().optional() }).describe('a (b)')"), "z.object().describe()")
  assert.equal(flattenCalls('aiPagesCount.optional()'), 'aiPagesCount.optional()')
  const web = webArgs()
  assert.ok(web.size >= 30, `expected the magazine actions on the web, found ${web.size}`)
  assert.equal(describeShape(web.get('magazine.goToPage')!.shape), 'page')
  // Multi-line objects, a refine() chain, a schema held in a variable.
  assert.equal(describeShape(web.get('magazine.replaceText')!.shape), 'find, matchCase?, replace, wholeWord?')
  assert.equal(describeShape(web.get('magazine.addChart')!.shape), 'chart, page?, replace?')
})

test('every magazine action takes the same arguments in the catalog and on the web', () => {
  const web = webArgs()
  const drift: string[] = []
  for (const a of actions) {
    const w = web.get(a.name)
    if (!w) continue // registration itself is operatorCatalog.test.ts's job
    const cat = describeShape(catalogArgs(a.args))
    const live = describeShape(w.shape)
    if (cat !== live) drift.push(`${a.name}: catalog { ${cat} } vs ${w.file} { ${live} }`)
  }
  assert.deepEqual(drift, [], 'the model would pass arguments the web action rejects, or never learn one it takes')
})

test('the page-checking, chart and replace actions are in the catalog, briefly', () => {
  // The fuller wording is the web description, which readScreen lists live; the
  // cached prompt keeps each of these to 200 characters (it is near its budget).
  for (const name of ['magazine.checkPage', 'magazine.lookAtPage', 'magazine.addChart', 'magazine.editChart', 'magazine.replaceText']) {
    const a = action(name)
    assert.ok(a.description.length <= 200, `${name}: description is ${a.description.length} characters (max 200)`)
  }
  assert.equal(action('magazine.replaceText').confirms, true, 'a magazine-wide replace is shown to the user (count per page) before it runs')
  // addChart has to tell the model the chart's whole shape — it cannot guess it.
  const chart = action('magazine.addChart').args
  for (const field of ["'barh'", "'donut'", "'table'", 'categories: string[]', 'values: number[]', 'unit?', 'highlight?', 'stacked?']) {
    assert.ok(chart.includes(field), `magazine.addChart args do not describe ${field}`)
  }
})

test('copyPdfPage takes the PDF from this chat itself, never through the studio composer (C18/C26)', async () => {
  const copy = action('magazine.copyPdfPage')
  assert.ok(catalogArgs(copy.args).get('attachment')?.optional, 'copyPdfPage must offer attachment?')
  assert.doesNotMatch(copy.description, /agentId:\s*"mag\.ai-attach"/, 'the composer paperclip only stages a file; it never reaches the Copy panel')
  const prompt = (await loadPromptModule()).getStaticOperatorPrompt()
  assert.doesNotMatch(prompt, /attach the PDF first with upload on\s+mag\.ai-attach/)
  assert.match(prompt, /copyPdfPage[^\n]*\n?[^\n]*attachment: 0/, 'the prompt should route a PDF sent in chat through attachment')
  assert.match(prompt, /mag\.ai-attach only stages a\s+file/, 'the prompt should say what mag.ai-attach really does')
})

test('the prompt verifies magazine pages by measuring them, and routes charts and word swaps (C15/C37/C48)', async () => {
  const prompt = (await loadPromptModule()).getStaticOperatorPrompt()
  // readScreen collects DOM text whether or not it is cut off and never sees a
  // picture: as the check for a page it passed clipped copy, and the model then
  // told the user it could not see the page.
  assert.doesNotMatch(prompt, /readScreen to check it is really on the page/)
  assert.match(prompt, /You CAN see pages/)
  assert.match(prompt, /never say you can't/)
  assert.match(prompt, /magazine\.checkPage/)
  // ...but it fixes only what was asked: after a build it ran page-by-page "fixes" for
  // half an hour of paid AI time without asking (2026-11-16). Report, ask, then ONE pass.
  assert.match(prompt, /FIX ONLY WHAT\s+WAS ASKED/)
  assert.match(prompt, /ASK\s+\(offer_choices: Fix all \/ Only page N \/ Not now\)/)
  assert.match(prompt, /magazine\.fixPages \(each page once\)/)
  assert.match(prompt, /Never loop\s+page by page with askStudio/)
  assert.match(prompt, /never fix unasked/)
  // ...and never puts element ids in front of the user (they showed in the Design Helper chat).
  assert.match(prompt, /name elements in words \(the headline, the byline\), never ids/)
  assert.doesNotMatch(prompt, /naming the element id/)
  assert.match(prompt, /CHARTS from numbers[^]*?magazine\.addChart with the EXACT numbers/)
  assert.match(prompt, /magazine\.replaceText/)
  assert.match(prompt, /photo \(the default, no words\), illustration, graphic, or\s+poster/)
})

test('no backticks in the magazine pack or in the prompt text around the catalog', async () => {
  const prompt = await loadPromptModule()
  const own = prompt.renderCatalog(SURFACES)
  assert.ok(!own.includes('`'), 'the magazine pack renders a backtick into the cached prompt')
  const around = prompt.getStaticOperatorPrompt().replace(prompt.renderCatalog(), '')
  assert.ok(!around.includes('`'), 'the static prompt text (outside the catalog) contains a backtick')
})
