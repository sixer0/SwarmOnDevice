import type { Prompt } from "@/context/prompt"

// Pure half of the composer preflight: what a draft refers to, what that resolves to in the real project, and which
// rows are worth a line of the user's attention. The controller does the I/O; nothing here touches the network.

const CODE_EXTENSIONS =
  "tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kts?|swift|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|json|ya?ml|toml|sql|sh|md|mdx|proto|tf|exs?|lua|dart|scala|zig|[ch]"

const PATH_TOKEN = new RegExp(
  `(^|[\\s("'\`=\\[<,@])((?:file:\\/\\/)?[\\w@.~\\\\/-]*[\\w-]\\.(?:${CODE_EXTENSIONS}))(?![\\w/-])(?::(\\d+))?(?::(\\d+))?`,
  "gm",
)
const PYTHON_FRAME = /File "([^"]+)", line (\d+)/g
const COMPILER_FRAME = new RegExp(`(^|\\s)([\\w@.~\\\\/-]+\\.(?:${CODE_EXTENSIONS}))\\((\\d+),(\\d+)\\)`, "gm")

const VENDOR_PATH =
  /(^|\/)(node_modules|site-packages|dist-packages|\.cargo|\.rustup|rustc|vendor|\.venv|venv)\/|^\/usr\/(lib|local|include)\/|^\/opt\/homebrew\/|\/go\/src\/(runtime|net|internal)\//
const GENERATED_PATH =
  /(^|\/)(dist|build|out|node_modules|vendor|target|coverage|\.next|\.turbo|__snapshots__)\/|\.min\.|\.lock$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/
// Product names that happen to look like a file. Without this every mention of Node.js would go looking for a file.
const NOT_A_FILE = /^(node|next|nuxt|vue|react|express|three|d3|deno|angular|ember|backbone|ext|alpine|svelte)\.js$/i
const TRACE_LINE = /^\s*(at\s|File "|-->|#\d+\s|\S+\.\w+:\d+)/
const BUILTIN_ERROR =
  /^(Type|Reference|Syntax|Range|URI|Eval|Aggregate|Value|Key|Attribute|Index|Import|Runtime|Name|Assertion|Null|Illegal|Unhandled)(Error|Exception|PointerException|ArgumentException)$/

const STOPWORDS = new Set(
  "about above after again all also always and any are because been before being below between both but can cannot change changes check code could does doing done down each error errors everything failing fails file files find first fix fixed fixes fixing for from function get getting going good have having here how implement into issue just keep like line lines look looks make makes making more most much need needs new not now off once only other our out over please problem really remove same see should some something still such sure than that the their them then there these they thing things this those through too try trying under update use used using very want wants was way were what when where which while who why will with without work working works would you your add adds added adding undefined null true false crash crashes run runs running test tests".split(
    " ",
  ),
)

export type PreflightRef = {
  raw: string
  path: string
  line?: number
  fromTrace: boolean
}

export type PreflightTerms = {
  identifiers: string[]
  words: string[]
}

export type ResolvedRef =
  | { kind: "found"; ref: PreflightRef; path: string }
  | { kind: "near"; ref: PreflightRef; path: string }
  | { kind: "missing"; ref: PreflightRef }
  | { kind: "ambiguous"; ref: PreflightRef }

export type IdentifierMatch =
  | { kind: "defined"; identifier: string; path: string; line: number }
  | { kind: "used"; identifier: string; path: string; line: number }
  | { kind: "missing"; identifier: string }

export type WordFile = { path: string; words: string[] }

export type PreflightSessionInfo = {
  id: string
  title: string
  updated: number
  parentID?: string
  archived?: number
}

export function promptText(parts: Prompt) {
  return parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")
}

export function extractRefs(text: string, directory: string): PreflightRef[] {
  const found = new Map<string, PreflightRef>()
  const add = (raw: string, rawPath: string, line: string | undefined, trace: boolean) => {
    const path = normalizeRefPath(rawPath, directory)
    if (!path || VENDOR_PATH.test(path)) return
    if (!path.includes("/") && NOT_A_FILE.test(path)) return
    const number = line ? Number(line) : undefined
    const key = `${path}\n${number ?? ""}`
    if (found.has(key)) return
    // A bare mention of a file the trace already points at carries no extra information.
    if (!number && [...found.values()].some((item) => item.path === path)) return
    if (number) found.delete(`${path}\n`)
    found.set(key, { raw, path, line: number, fromTrace: trace })
  }

  for (const match of text.matchAll(PYTHON_FRAME)) add(match[0], match[1]!, match[2], true)
  for (const match of text.matchAll(COMPILER_FRAME)) add(match[2]!, match[2]!, match[3], true)
  for (const match of text.matchAll(PATH_TOKEN)) {
    const raw = match[0].slice(match[1]!.length)
    add(raw, match[2]!, match[3], !!match[3])
  }
  return [...found.values()].slice(0, 8)
}

export function normalizeRefPath(input: string, directory: string) {
  const path = input
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
  const root = directory.replace(/\/+$/, "")
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  // macOS resolves /tmp and /var through /private, so the server can report the same folder under either spelling.
  if (root && path.startsWith(`/private${root}/`)) return path.slice(root.length + 9)
  return path
}

export function resolveRef(ref: PreflightRef, candidates: string[]): ResolvedRef {
  if (candidates.includes(ref.path)) return { kind: "found", ref, path: ref.path }
  const segments = ref.path.split("/").filter((segment) => segment && segment !== "..")
  const name = segments.at(-1) ?? ""
  const scored = candidates
    .filter((path) => path.split("/").at(-1) === name)
    .map((path) => ({ path, shared: sharedTail(segments, path.split("/")) }))
  const best = Math.max(0, ...scored.map((item) => item.shared))
  const top = scored.filter((item) => item.shared === best)
  if (top.length === 1) return { kind: "found", ref, path: top[0]!.path }
  if (top.length > 1) return { kind: "ambiguous", ref }

  const near = candidates
    .map((path) => ({ path, distance: editDistance(path.split("/").at(-1) ?? "", name) }))
    .filter((item) => item.distance > 0 && item.distance <= 2 && name.length >= 5)
    .sort((a, b) => a.distance - b.distance || a.path.length - b.path.length)
  if (near[0] && near[0].distance < (near[1]?.distance ?? Infinity)) return { kind: "near", ref, path: near[0].path }
  return { kind: "missing", ref }
}

function sharedTail(a: string[], b: string[]) {
  const limit = Math.min(a.length, b.length)
  const shared = Array.from({ length: limit }).findIndex((_, i) => a[a.length - 1 - i] !== b[b.length - 1 - i])
  return shared === -1 ? limit : shared
}

export function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  Array.from(a).forEach((charA, i) => {
    let previous = row[0]!
    row[0] = i + 1
    Array.from(b).forEach((charB, j) => {
      const current = row[j + 1]!
      row[j + 1] = Math.min(current + 1, row[j]! + 1, previous + (charA === charB ? 0 : 1))
      previous = current
    })
  })
  return row[b.length]!
}

export function extractTerms(text: string, refs: PreflightRef[]): PreflightTerms {
  const prose = text
    .split("\n")
    .filter((line) => !TRACE_LINE.test(line))
    .join("\n")
  const clean = refs.reduce((value, ref) => value.split(ref.raw).join(" "), prose)
  const quoted = Array.from(clean.matchAll(/`([\w$.-]{3,})`/g), (match) => match[1]!)
  const shaped = Array.from(
    clean.matchAll(/\b(?:[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g),
    (match) => match[0],
  )
  const called = Array.from(clean.matchAll(/\b([A-Za-z_$][\w$]{2,})\(\)/g), (match) => match[1]!)
  const identifiers = unique([...quoted, ...shaped, ...called])
    .filter((value) => !BUILTIN_ERROR.test(value))
    .slice(0, 3)
  const taken = new Set(identifiers.map((value) => value.toLowerCase()))
  const words = unique(
    Array.from(clean.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}-]{3,}/gu), (match) => match[0]).filter(
      (word) => !STOPWORDS.has(word) && !taken.has(word),
    ),
  ).slice(0, 5)
  return { identifiers, words }
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

function nameTokens(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function wordHits(word: string, token: string) {
  if (word === token) return true
  // Light stemming: "rounding" should find round.ts and "invoices" invoice.ts, without "test" finding "contest".
  return token.length >= 4 && word.length >= 4 && (word.startsWith(token) || token.startsWith(word))
}

export function rankWordFiles(results: Record<string, string[]>, skip: Set<string>): WordFile[] {
  const scores = new Map<string, { named: Set<string>; folder: Set<string> }>()
  Object.entries(results).forEach(([word, paths]) =>
    paths
      .filter((path) => !GENERATED_PATH.test(path) && !skip.has(path))
      .forEach((path) => {
        const segments = path.split("/")
        const score = scores.get(path) ?? { named: new Set<string>(), folder: new Set<string>() }
        if (nameTokens(segments.at(-1)!.replace(/\.[^.]+$/, "")).some((token) => wordHits(word, token))) {
          score.named.add(word)
        }
        if (segments.slice(0, -1).flatMap(nameTokens).some((token) => wordHits(word, token))) score.folder.add(word)
        scores.set(path, score)
      }),
  )
  return [...scores.entries()]
    .filter(([, score]) => score.named.size > 0)
    .map(([path, score]) => ({
      path,
      words: [...score.named],
      score: score.named.size * 2 + [...score.folder].filter((word) => !score.named.has(word)).length,
    }))
    .sort(
      (a, b) =>
        b.score - a.score || Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.length - b.path.length,
    )
    .slice(0, 3)
    .map((item) => ({ path: item.path, words: item.words }))
}

function isTestPath(path: string) {
  return /(^|[./_-])(test|tests|spec|specs|__tests__)([./_-]|$)/.test(path)
}

export function definitionPattern(identifier: string) {
  return `\\b(function\\*?|class|const|let|var|def|fn|type|interface|struct|func|enum|trait|module)\\s+${escapeRegex(identifier)}\\b`
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function pickIdentifier(
  identifier: string,
  definitions: { path: string; line: number }[],
  uses: { path: string; line: number }[],
): IdentifierMatch {
  const definition = definitions.find((hit) => !GENERATED_PATH.test(hit.path))
  if (definition) return { kind: "defined", identifier, path: definition.path, line: definition.line }
  const use = uses.find((hit) => !GENERATED_PATH.test(hit.path))
  if (use) return { kind: "used", identifier, path: use.path, line: use.line }
  return { kind: "missing", identifier }
}

// Titles are model-written summaries, so shared words mean more than shared characters. Two meaningful shared words
// and at least half the title keeps "Fix login" from matching every session that fixes anything.
export function similarSessions(text: string, sessions: PreflightSessionInfo[], currentID?: string) {
  const asked = new Set(meaningfulWords(text))
  return sessions
    .filter((session) => !session.parentID && !session.archived && session.id !== currentID)
    .flatMap((session) => {
      const title = unique(meaningfulWords(session.title))
      const shared = title.filter((word) => [...asked].some((candidate) => wordHits(candidate, word)))
      if (shared.length < 2 || shared.length / title.length < 0.5) return []
      return [{ session, shared: shared.length }]
    })
    .sort((a, b) => b.shared - a.shared || b.session.updated - a.session.updated)
    .slice(0, 2)
    .map((item) => item.session)
}

function meaningfulWords(text: string) {
  return Array.from(text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}]{2,}/gu), (match) => match[0]).filter(
    (word) => !STOPWORDS.has(word),
  )
}

export function detectChecks(input: { rootFiles: string[]; packageJson?: string; makefile?: string }) {
  const has = (name: string) => input.rootFiles.includes(name)
  const scripts = packageScripts(input.packageJson)
  const runner = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm"
  const fromPackage = ["typecheck", "test", "lint"]
    .filter((name) => scripts[name] && !/no test specified/i.test(scripts[name]!))
    .map((name) => `${runner} run ${name}`)
  return [
    ...fromPackage,
    ...(has("Cargo.toml") ? ["cargo test"] : []),
    ...(has("go.mod") ? ["go test ./..."] : []),
    ...(has("pyproject.toml") || has("pytest.ini") || has("tox.ini") ? ["pytest"] : []),
    ...(has("build.gradle") || has("build.gradle.kts") ? ["./gradlew test"] : []),
    ...(has("pom.xml") ? ["mvn test"] : []),
    ...(fromPackage.length === 0 && input.makefile && /^test\s*:/m.test(input.makefile) ? ["make test"] : []),
  ].slice(0, 3)
}

function packageScripts(json: string | undefined): Record<string, string | undefined> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  } catch {
    // A half-edited package.json must not take the composer with it; there is simply nothing to suggest.
    return {}
  }
}

export function mentionsChecks(text: string, commands: string[]) {
  if (commands.some((command) => text.includes(command))) return true
  return /\b(run|running|execute|verify|verified|make sure)\b[^.\n]*\b(tests?|typecheck|type-check|lint|build)\b/i.test(text)
}

export function checksInstruction(commands: string[]) {
  return commands.map((command) => `\`${command}\``).join(", ")
}

// The composer stores character offsets on every part, so edits rebuild them rather than patching one part.
function reindex(parts: Prompt): Prompt {
  let offset = 0
  return parts.map((part) => {
    if (part.type === "image") return part
    const start = offset
    offset += part.content.length
    return { ...part, start, end: offset }
  })
}

export function replaceInPrompt(parts: Prompt, from: string, to: string): Prompt {
  let done = false
  return reindex(
    parts.map((part) => {
      if (done || part.type !== "text" || !part.content.includes(from)) return part
      done = true
      return { ...part, content: part.content.replace(from, () => to) }
    }),
  )
}

export function appendToPrompt(parts: Prompt, text: string): Prompt {
  const last = parts.findLastIndex((part) => part.type === "text")
  if (last === -1) return reindex([...parts, { type: "text", content: text, start: 0, end: 0 }])
  return reindex(
    parts.map((part, index) =>
      index === last && part.type === "text"
        ? { ...part, content: `${part.content.replace(/\s+$/, "")}\n\n${text}` }
        : part,
    ),
  )
}

export function lineWindow(line: number) {
  return { start: Math.max(1, line - 15), end: line + 15 }
}

export type PreflightFacts = {
  refs: ResolvedRef[]
  identifiers: IdentifierMatch[]
  files: WordFile[]
  dirty: string[]
  busy: { id: string; title: string; files: string[] }[]
  similar: PreflightSessionInfo[]
  checks: string[]
}

export type PreflightItem =
  | { key: string; kind: "trace"; path: string; line: number }
  | { key: string; kind: "mention"; path: string; line?: number }
  | { key: string; kind: "definition"; path: string; line: number; identifier: string }
  | { key: string; kind: "use"; path: string; line: number; identifier: string }
  | { key: string; kind: "word"; path: string; words: string[] }
  | { key: string; kind: "typo"; raw: string; written: string; path: string; line?: number }
  | { key: string; kind: "missing-path"; path: string }
  | { key: string; kind: "missing-identifier"; identifier: string }
  | { key: string; kind: "busy"; id: string; title: string; overlap: string[] }
  | { key: string; kind: "dirty"; count: number; overlap: string[] }
  | { key: string; kind: "similar"; id: string; title: string; updated: number }
  | { key: string; kind: "checks"; commands: string[] }

export const isAttachItem = (
  item: PreflightItem,
): item is Extract<PreflightItem, { kind: "trace" | "mention" | "definition" | "use" | "word" }> =>
  item.kind === "trace" ||
  item.kind === "mention" ||
  item.kind === "definition" ||
  item.kind === "use" ||
  item.kind === "word"

export function buildItems(input: {
  facts: PreflightFacts
  text: string
  attached: string[]
  dismissed: Record<string, boolean | undefined>
  isolated: boolean
}): PreflightItem[] {
  const attached = new Set(input.attached)
  const covered = new Set(input.attached)
  const take = (path: string) => {
    if (covered.has(path)) return false
    covered.add(path)
    return true
  }

  // Most specific evidence first. Once a trace claims a file, a filename guess must not list it a second time.
  const refs = input.facts.refs.flatMap((resolved): PreflightItem[] => {
    if (resolved.kind === "found") {
      if (!take(resolved.path)) return []
      return resolved.ref.line
        ? [{ key: `trace:${resolved.path}`, kind: "trace", path: resolved.path, line: resolved.ref.line }]
        : [{ key: `mention:${resolved.path}`, kind: "mention", path: resolved.path }]
    }
    if (resolved.kind === "near") {
      return [
        {
          key: `typo:${resolved.ref.path}`,
          kind: "typo",
          raw: resolved.ref.raw,
          written: resolved.ref.path,
          path: resolved.path,
          line: resolved.ref.line,
        },
      ]
    }
    // A bare `config.json` may just be an example. Only a written-out path is a claim worth correcting.
    if (resolved.kind === "missing" && resolved.ref.path.includes("/") && !resolved.ref.path.startsWith("/")) {
      return [{ key: `missing:${resolved.ref.path}`, kind: "missing-path", path: resolved.ref.path }]
    }
    return []
  })
  const identifiers = input.facts.identifiers.flatMap((match): PreflightItem[] => {
    if (match.kind === "missing") {
      return [{ key: `missing-id:${match.identifier}`, kind: "missing-identifier", identifier: match.identifier }]
    }
    if (!take(match.path)) return []
    return [
      {
        key: `id:${match.identifier}`,
        kind: match.kind === "defined" ? "definition" : "use",
        path: match.path,
        line: match.line,
        identifier: match.identifier,
      },
    ]
  })
  const files = input.facts.files.flatMap((file): PreflightItem[] =>
    take(file.path) ? [{ key: `word:${file.path}`, kind: "word", path: file.path, words: file.words }] : [],
  )

  const named = new Set([
    ...attached,
    ...input.facts.refs.flatMap((ref) => (ref.kind === "found" ? [ref.path] : [])),
    ...input.facts.identifiers.flatMap((match) => (match.kind === "defined" ? [match.path] : [])),
  ])
  const busy = input.isolated
    ? []
    : input.facts.busy.map(
        (session): PreflightItem => ({
          key: `busy:${session.id}`,
          kind: "busy",
          id: session.id,
          title: session.title,
          overlap: session.files.filter((file) => named.has(file)),
        }),
      )
  const dirtyOverlap = input.facts.dirty.filter((file) => named.has(file))
  const dirty: PreflightItem[] =
    !input.isolated && input.facts.dirty.length > 0
      ? [{ key: "dirty", kind: "dirty", count: input.facts.dirty.length, overlap: dirtyOverlap }]
      : []
  const similar = input.facts.similar.map(
    (session): PreflightItem => ({
      key: `similar:${session.id}`,
      kind: "similar",
      id: session.id,
      title: session.title,
      updated: session.updated,
    }),
  )
  const checks: PreflightItem[] =
    input.facts.checks.length > 0 && !mentionsChecks(input.text, input.facts.checks)
      ? [{ key: "checks", kind: "checks", commands: input.facts.checks }]
      : []

  return [...refs, ...identifiers, ...files, ...busy, ...dirty, ...similar, ...checks].filter(
    (item) => !input.dismissed[item.key],
  )
}
