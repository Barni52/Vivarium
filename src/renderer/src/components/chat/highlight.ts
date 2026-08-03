import Prism from 'prismjs'
// Grammar order is load-bearing. Each component file is an IIFE that reads the
// global `Prism` the core installed and *extends* what is already registered, so
// a language must come after everything it derives from: `tsx` is `jsx` plus
// `typescript`, `jsx` is `markup` plus `javascript`, `cpp` is `c`, and the whole
// C family is `clike`. The `prismjs` entry above is core plus markup, css, clike
// and javascript, which is why those four are absent from this list.
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-diff'
import { CODE } from '../../theme'

// Syntax highlighting for the chat log — the whole of it, so that `Markdown` and
// `ChatLog` learn nothing about Prism beyond `{ text, color }`.
//
// **Prism is used as a tokenizer and never as a renderer.** `Prism.highlight()`
// returns an HTML string and is not called anywhere; `Prism.tokenize()` returns a
// tree of `Token` objects, which `flatten` below turns into a flat list of
// coloured runs for the caller to map onto `<span>`s. That is the whole reason
// this integration is allowed to exist: the rule `Markdown.tsx` is built around
// is that model output reaches the DOM as text nodes and never as markup, and a
// token tree keeps that true where an HTML string would hand it away.
//
// Everything here has to survive being called ~30 times a second on a *growing
// prefix* of a half-arrived answer (see `ChatLog`'s reveal): a fence is open and
// unterminated for most of its life on screen and the last token is perpetually
// cut mid-word. Prism handles that natively — an unterminated string is simply a
// string that runs to the end of the input — but it is why `tokenize` must never
// throw, and why an unknown language returns plain text rather than guessing.

/** One run of code that shares a colour. `color` absent means "inherit". */
export interface Tok {
  text: string
  color?: string
}

/**
 * Prism token type → palette entry.
 *
 * Read by **type first and `alias` only as a fallback**, which is the opposite of
 * what a Prism theme stylesheet does and is deliberate: several grammars alias a
 * token to something that reads wrong here. Java's `annotation` is aliased to
 * `punctuation`, so alias-first would print `@Override` in the same grey as a
 * semicolon; its `triple-quoted-string` is aliased to `string` and has no entry
 * of its own, which is exactly the case the fallback is for.
 */
const ROLE: Record<string, string> = {
  comment: CODE.comment,
  prolog: CODE.comment,
  doctype: CODE.comment,
  cdata: CODE.comment,
  shebang: CODE.comment,
  // A diff's `--- a/x` / `@@ ... @@` headers are addressing, not content.
  coord: CODE.comment,

  punctuation: CODE.punct,
  operator: CODE.punct,
  entity: CODE.punct,
  arrow: CODE.punct,
  spread: CODE.punct,

  keyword: CODE.keyword,
  atrule: CODE.keyword,
  rule: CODE.keyword,
  important: CODE.keyword,
  directive: CODE.keyword,
  import: CODE.keyword,
  static: CODE.keyword,

  string: CODE.string,
  char: CODE.string,
  regex: CODE.string,
  'attr-value': CODE.string,
  'template-string': CODE.string,
  'triple-quoted-string': CODE.string,
  'string-interpolation': CODE.string,
  scalar: CODE.string,

  number: CODE.number,
  boolean: CODE.number,
  symbol: CODE.number,
  datetime: CODE.number,
  // `null` sits with the numbers rather than the keywords so that the three
  // things a JSON value can literally be — `true`, `false`, `null` — agree.
  null: CODE.number,

  function: CODE.fn,
  'function-name': CODE.fn,
  'function-variable': CODE.fn,
  'generic-method': CODE.fn,
  method: CODE.fn,
  macro: CODE.fn,
  // `$FOO` in shell, a bind parameter in SQL: a reference to a name.
  variable: CODE.fn,

  'class-name': CODE.type,
  'maybe-class-name': CODE.type,
  // Not a value literal — Prism's `constant` is the ALL-CAPS *identifier* heuristic
  // (`/\b[A-Z][A-Z\d_]*\b/`), and a one-letter generic parameter satisfies it, so
  // `T` in `Promise<T>` and `K`/`V` in `Map<K, V>` arrive here. With this on the
  // number hue they came out amber, a type in the colour of a numeric literal
  // immediately beside `Promise` in the colour of a type. The real literals
  // (`number`, `boolean`, `null`) have their own entries and are unaffected; the
  // trade is that a `MAX_CHARS` reads as sand, which is what every other name does.
  constant: CODE.type,
  'known-class-name': CODE.type,
  'type-definition': CODE.type,
  'type-expression': CODE.type,
  'return-type': CODE.type,
  'lifetime-annotation': CODE.type,
  'literal-property': CODE.type,
  'attr-name': CODE.type,
  generics: CODE.type,
  namespace: CODE.type,
  builtin: CODE.type,
  annotation: CODE.type,
  decorator: CODE.type,
  attribute: CODE.type,
  selector: CODE.type,
  property: CODE.type,
  tag: CODE.type,
  // YAML's `key` is aliased to `atrule`; without an entry of its own a mapping
  // key would come out keyword-violet while the same key in JSON came out sand.
  key: CODE.type,

  'inserted-sign': CODE.ins,
  inserted: CODE.ins,
  'deleted-sign': CODE.del,
  deleted: CODE.del
}

/**
 * Fence info string → grammar key.
 *
 * `js` maps to `javascript` rather than to the JSX superset on purpose: the JSX
 * grammar reads `<` as the start of a tag, so `a < b && c > d` in plain
 * JavaScript comes out as an element. The superset is only used where the fence
 * actually asked for it.
 */
const LANGS: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  kotlin: 'kotlin',
  cs: 'csharp',
  csharp: 'csharp',
  'c#': 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  python3: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  sql: 'sql',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  xhtml: 'markup',
  svg: 'markup',
  vue: 'markup',
  markup: 'markup',
  css: 'css',
  // Close enough to read by: the cascade, the selectors and the values all
  // tokenize, and only nesting and `@mixin` fall through as plain text.
  scss: 'css',
  less: 'css',
  diff: 'diff',
  patch: 'diff'
}

/** File extension → grammar key, for a tool card that names the file it edited. */
const EXTS: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  go: 'go',
  rs: 'rust',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  css: 'css',
  scss: 'css',
  less: 'css',
  diff: 'diff',
  patch: 'diff'
}

/**
 * A block big enough that tokenizing it every reveal tick would be felt.
 *
 * Nothing a conversation contains comes close — this is the guard against a
 * pasted minified bundle, where the cost is not the length so much as the single
 * unbroken line the backtracking then runs over.
 */
const MAX = 120_000

/**
 * The one place `Prism.manual` can still be set and mean something.
 *
 * The core schedules an automatic `highlightAll()` over the document on the next
 * animation frame, and that callback re-reads the flag when it runs — so setting
 * it here, synchronously as this module is evaluated, gets in first. Nothing in
 * this app carries the `class="language-*"` the sweep looks for, so today it
 * would find nothing anyway; the point is that it stays that way for whoever
 * adds such a class later without knowing a sweep exists.
 *
 * The cast is because `@types/prismjs` declares `manual` as an `export let`, and
 * a module's exported binding is read-only through the import.
 */
;(Prism as { manual?: boolean }).manual = true

/** The grammar key a fence's info string asks for, or `''` for "leave it plain". */
export function langFor(info: string): string {
  return LANGS[info.trim().toLowerCase()] ?? ''
}

/** The grammar key a file path implies, or `''`. Handles a path with no extension. */
export function langForPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return EXTS[name.slice(dot + 1).toLowerCase()] ?? ''
}

/** The colour for one token, or `undefined` to inherit the enclosing run's. */
function roleOf(token: Prism.Token): string | undefined {
  const own = ROLE[token.type]
  if (own) return own
  const alias = token.alias
  if (typeof alias === 'string') return ROLE[alias]
  if (Array.isArray(alias)) {
    for (const a of alias) if (ROLE[a]) return ROLE[a]
  }
  return undefined
}

/**
 * Token tree → flat coloured runs.
 *
 * Nested content **inherits** the enclosing token's colour rather than falling
 * back to plain, which is what makes the compound tokens come out right: a diff's
 * `deleted-sign` wraps `line` and `prefix` children that carry no colour of their
 * own, and without inheritance a removed line would tokenize into red nothing.
 * The same rule keeps the literal halves of a template string green while an
 * `${…}` interpolation inside it still gets its own hues.
 *
 * Adjacent runs sharing a colour are merged as they are pushed. Most of a code
 * block is plain text between short coloured tokens, so this is the difference
 * between a `<span>` per identifier and one per *paragraph* of code.
 */
function flatten(nodes: Array<string | Prism.Token>, inherited: string | undefined, out: Tok[]): void {
  for (const node of nodes) {
    if (typeof node === 'string') {
      push(out, node, inherited)
      continue
    }
    const color = roleOf(node) ?? inherited
    const content = node.content
    if (typeof content === 'string') push(out, content, color)
    else if (Array.isArray(content)) flatten(content, color, out)
    else flatten([content], color, out)
  }
}

function push(out: Tok[], text: string, color: string | undefined): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.color === color) last.text += text
  else out.push(color ? { text, color } : { text })
}

/**
 * Highlight `code` as `lang`, or hand it back as one plain run.
 *
 * The plain path is taken for an unknown or absent language, a grammar that
 * failed to register, an oversized block, and anything Prism throws on — a code
 * block that renders uncoloured is a non-event, and one that takes the log down
 * with it is not.
 */
export function tokenize(code: string, lang: string): Tok[] {
  if (!code) return []
  const grammar = lang ? Prism.languages[lang] : undefined
  if (!grammar || code.length > MAX) return [{ text: code }]
  try {
    const out: Tok[] = []
    flatten(Prism.tokenize(code, grammar), undefined, out)
    return out
  } catch {
    return [{ text: code }]
  }
}
