import type { Message, Part } from "@opencode-ai/sdk/v2"
import { buildSessionMap, type MapStep } from "../map/session-map-model"

// A large diff written by an agent raises three questions the diff itself does not answer: was this checked after the
// last edit, where should I look first, and why was this file touched. This module answers them from what is already
// on record, the patches and the session's tool calls. It uses fixed rules, costs nothing and sends nothing anywhere.
// A clean result means "no rule fired", never "this is safe", and the UI has to say so. Pure, so it can be tested and
// rebuilt as parts arrive.

export type CheckKind = "test" | "typecheck" | "lint" | "build"
export type CheckStatus = "passed" | "failed" | "hidden" | "running"
export type Severity = "high" | "medium" | "low"
export type FlagKind =
  | "tests-removed"
  | "assertions-removed"
  | "expectation-changed"
  | "test-skipped"
  | "secret"
  | "suppression"
  | "swallowed-error"
  | "dangerous"
  | "dependency"
  | "sensitive-path"
  | "file-deleted"
  | "mostly-deleted"
  | "lockfile-alone"
  | "not-assessed"
  | "leftover"
export type FileTrait = "formatting" | "imports" | "lockfile" | "generated" | "docs" | "tests"
export type BriefGroupID = "look" | "read" | "skim" | "elsewhere"
export type ReviewVerdict = "ok" | "work"
export type ReviewMark = { hash: string; verdict: ReviewVerdict }
export type FileMark = "none" | ReviewVerdict | "changed"

export type PatchLine = { line: number; text: string }
export type ParsedPatch = { added: PatchLine[]; removed: PatchLine[]; hunks: number }

export type FlagLine = PatchLine & { side: "additions" | "deletions" }
export type Flag = { kind: FlagKind; severity: Severity; count: number; lines: FlagLine[]; detail?: string }

export type DiffInput = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const MAX_ASSESSED_PATCH = 2_000_000

export function parsePatch(patch: string): ParsedPatch {
  const result: ParsedPatch = { added: [], removed: [], hunks: 0 }
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const raw of patch.split("\n")) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const head = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!head) continue
      oldLine = Number(head[1])
      oldLeft = head[2] === undefined ? 1 : Number(head[2])
      newLine = Number(head[3])
      newLeft = head[4] === undefined ? 1 : Number(head[4])
      result.hunks += 1
      continue
    }
    const mark = raw[0]
    if (mark === "+") {
      result.added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
      newLeft -= 1
    } else if (mark === "-") {
      result.removed.push({ line: oldLine, text: raw.slice(1) })
      oldLine += 1
      oldLeft -= 1
    } else if (mark === "\\") {
      continue
    } else {
      oldLine += 1
      newLine += 1
      oldLeft -= 1
      newLeft -= 1
    }
  }
  return result
}

/** Identifies what changed, not where: an unrelated edit above a hunk must not undo a person's review of it. */
export function changeHash(diff: Pick<DiffInput, "patch" | "additions" | "deletions">) {
  let hash = 0x811c9dc5
  const add = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  const parsed = parsePatch(diff.patch ?? "")
  if (parsed.hunks === 0) add(`${diff.additions}:${diff.deletions}`)
  parsed.removed.forEach((item) => add("-" + item.text + "\n"))
  parsed.added.forEach((item) => add("+" + item.text + "\n"))
  return (hash >>> 0).toString(36)
}

// ---- What kind of file is this ---------------------------------------------------------------------------------------

const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock)$/
const GENERATED =
  /(\.gen\.|\.generated\.|\.min\.(js|css)$|\.snap$|(^|\/)(gen|dist|build|__snapshots__|vendor|node_modules)\/)/
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.\w+$|_test\.\w+$|(^|\/)test_\w+\.py$/
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(LICENSE|NOTICE|CHANGELOG)[^/]*$/
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|cfg|conf)$|(^|\/)\.[\w.-]+rc(\.\w+)?$|\.config\.\w+$/
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(migrations?|schema)(\/|\.)|\.sql$/i,
  /^\.github\/|^\.gitlab-ci|^\.circleci\/|(^|\/)Dockerfile|(^|\/)docker-compose|(^|\/)Jenkinsfile/,
  /(^|[/._-])(auth|authn|authz|oauth|security|permissions?|crypto|secrets?|payments?|billing)([/._-]|$)/i,
]

export const isTestFile = (file: string) => TEST_FILE.test(file)
const isCode = (file: string) =>
  !LOCKFILE.test(file) && !GENERATED.test(file) && !isTestFile(file) && !DOC_FILE.test(file) && !CONFIG_FILE.test(file)

// ---- Rules over the changed lines ------------------------------------------------------------------------------------

const TEST_CASE =
  /^\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|(?:async\s+)?def\s+test_|func\s+Test[A-Z_]|#\[(?:tokio::)?test\]|@Test\b)/
const ASSERTION = /\b(?:expect|assert\w*|t\.(?:Error|Fatal)\w*|require\.\w+)\s*[(.]|^\s*assert\s/
const TEST_SKIP =
  /\b(?:it|test|describe)\.(?:skip|only|todo|failing)\b|\b(?:xit|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)|#\[ignore\]|\bt\.Skip\w*\(|@Disabled\b|@Ignore\b/
const SECRET = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i,
]
const SUPPRESSION =
  /@ts-(?:ignore|nocheck|expect-error)|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#\[allow\(|@SuppressWarnings|\bas\s+any\b|:\s*any\b(?!\w)/
const SWALLOWED =
  /catch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(?:\([^)]*\)|\w+)?\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)|^\s*except(?:\s+\w+)?\s*:\s*pass\b|\|\|\s*true\s*$/
const DANGEROUS =
  /\beval\s*\(|\bnew Function\s*\(|dangerouslySetInnerHTML|\.innerHTML\s*=|\brm\s+-[a-z]*r[a-z]*f|\bchmod\s+777\b|rejectUnauthorized:\s*false|verify\s*=\s*False\b|--no-verify\b|\bcurl\b[^|\n]*\|\s*(?:ba)?sh\b|\b(?:DROP|TRUNCATE)\s+TABLE\b|\bshell\s*=\s*True\b/
const LEFTOVER = /\bconsole\.(?:log|debug)\s*\(|\bdebugger\b|\bdbg!\(|\bbreakpoint\(\)|\b(?:TODO|FIXME|XXX|HACK)\b/
const COMMENT_LINE = /^\s*(?:\/\/|#(?!\[)|\/?\*|--\s)/
const IMPORT_LINE =
  /^\s*(?:import\b|from\s+\S+\s+import\b|export\s+\*\s+from\b|export\s+\{[^}]*\}\s+from\b|use\s+\S+;|using\s+\S+;|#include\b|.*=\s*require\()/
const DEPENDENCY_FILE = /(^|\/)(package\.json|requirements[^/]*\.txt)$/
const DEPENDENCY_LINE =
  /^\s*"(@?[\w./-]+)"\s*:\s*"(?:[\^~<>=]*\d|workspace:|catalog:|npm:|github:|file:)|^\s*([A-Za-z][\w.-]*)\s*(?:==|>=|~=)\s*\d/
const MANIFEST_FOR_LOCK: [RegExp, RegExp][] = [
  [/(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, /(^|\/)package\.json$/],
  [/Cargo\.lock$/, /(^|\/)Cargo\.toml$/],
  [/go\.sum$/, /(^|\/)go\.mod$/],
  [/(poetry\.lock|uv\.lock)$/, /(^|\/)pyproject\.toml$/],
]

const literalShape = (text: string) =>
  text
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "§")
    .replace(/\b\d+(?:\.\d+)?\b/g, "§")
    .trim()

const lineList = (items: PatchLine[], side: FlagLine["side"]): FlagLine[] => items.map((item) => ({ ...item, side }))

export function assessFile(
  diff: DiffInput,
  allFiles: readonly string[],
): { flags: Flag[]; trait?: FileTrait; assessed: boolean } {
  const file = diff.file
  const test = isTestFile(file)
  const flags: Flag[] = []
  const flag = (kind: FlagKind, severity: Severity, lines: FlagLine[], count = lines.length, detail?: string) =>
    flags.push({ kind, severity, count: Math.max(count, 1), lines: lines.slice(0, 50), detail })
  const finish = (trait?: FileTrait, assessed = true) => ({
    flags: flags.toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    trait,
    assessed,
  })

  if (LOCKFILE.test(file)) {
    const manifest = MANIFEST_FOR_LOCK.find(([lock]) => lock.test(file))?.[1]
    if (manifest && !allFiles.some((item) => manifest.test(item))) flag("lockfile-alone", "medium", [], 1)
    return finish("lockfile")
  }
  if (GENERATED.test(file)) return finish("generated")

  const size = diff.additions + diff.deletions
  const hasPatch = !!diff.patch && diff.patch.length <= MAX_ASSESSED_PATCH
  const parsed = hasPatch ? parsePatch(diff.patch!) : { added: [], removed: [], hunks: 0 }
  // With no readable hunks nothing below can fire, and silence would read as "fine". Say it was not looked at.
  if (size > 0 && parsed.hunks === 0) {
    flag("not-assessed", "medium", [], 1)
    return finish(undefined, false)
  }

  const { added, removed } = parsed
  if (SENSITIVE_PATH.some((rule) => rule.test(file))) flag("sensitive-path", "medium", [], 1)

  const secrets = added.filter((item) => SECRET.some((rule) => rule.test(item.text)))
  if (secrets.length) flag("secret", "high", lineList(secrets, "additions"))

  if (DOC_FILE.test(file)) return finish("docs")

  if (test) {
    const addedCases = added.filter((item) => TEST_CASE.test(item.text))
    const removedCases = removed.filter((item) => TEST_CASE.test(item.text))
    if (diff.status === "deleted" || removedCases.length > addedCases.length) {
      flag(
        "tests-removed",
        "high",
        lineList(removedCases, "deletions"),
        diff.status === "deleted" ? removedCases.length : removedCases.length - addedCases.length,
      )
    }
    const addedAsserts = added.filter((item) => ASSERTION.test(item.text))
    const removedAsserts = removed.filter((item) => ASSERTION.test(item.text))
    // The shape with its literals blanked pairs `toBe(10)` with `toBe(11)`: same check, different expectation.
    const removedShapes = new Map<string, PatchLine>()
    removedAsserts.forEach((item) => removedShapes.set(literalShape(item.text), item))
    const changed = addedAsserts.filter((item) => {
      const before = removedShapes.get(literalShape(item.text))
      return before && before.text.trim() !== item.text.trim()
    })
    if (changed.length) flag("expectation-changed", "high", lineList(changed, "additions"))
    if (diff.status !== "deleted" && removedAsserts.length > addedAsserts.length) {
      flag(
        "assertions-removed",
        "high",
        lineList(removedAsserts, "deletions"),
        removedAsserts.length - addedAsserts.length,
      )
    }
    const skipped = added.filter((item) => TEST_SKIP.test(item.text))
    if (skipped.length) flag("test-skipped", "high", lineList(skipped, "additions"))
  }

  const suppressed = added.filter((item) => SUPPRESSION.test(item.text))
  if (suppressed.length) flag("suppression", test ? "low" : "medium", lineList(suppressed, "additions"))

  const code = added.filter((item) => !COMMENT_LINE.test(item.text))
  const swallowed = code.filter((item) => SWALLOWED.test(item.text))
  if (swallowed.length) flag("swallowed-error", test ? "low" : "medium", lineList(swallowed, "additions"))

  if (!test) {
    const dangerous = code.filter((item) => DANGEROUS.test(item.text))
    if (dangerous.length) flag("dangerous", "high", lineList(dangerous, "additions"))
    if (diff.status === "deleted" && isCode(file)) flag("file-deleted", "medium", [], 1)
    else if (isCode(file) && diff.deletions >= 80 && diff.additions < diff.deletions * 0.2) {
      flag("mostly-deleted", "medium", [], diff.deletions)
    }
    const leftovers = added.filter((item) => LEFTOVER.test(item.text))
    if (leftovers.length) flag("leftover", "low", lineList(leftovers, "additions"))
  }

  if (DEPENDENCY_FILE.test(file)) {
    const before = new Set(removed.map((item) => dependencyName(item.text)))
    const fresh = added.filter((item) => {
      const name = dependencyName(item.text)
      return name && !before.has(name)
    })
    if (fresh.length) {
      flag(
        "dependency",
        "medium",
        lineList(fresh, "additions"),
        fresh.length,
        fresh
          .flatMap((item) => dependencyName(item.text) ?? [])
          .slice(0, 3)
          .join(", "),
      )
    }
  }

  // Joined, not compared line by line: rewrapping a statement splits one line into two without changing a thing.
  const strip = (items: PatchLine[]) => items.map((item) => item.text.replace(/\s+/g, "")).join("")
  if (added.length + removed.length > 0 && strip(added) === strip(removed)) return finish("formatting")
  const changedLines = [...added, ...removed].filter((item) => item.text.trim())
  if (changedLines.length > 0 && changedLines.every((item) => IMPORT_LINE.test(item.text))) return finish("imports")
  return finish(test ? "tests" : undefined)
}

function dependencyName(text: string) {
  if (/^\s*"(?:version|name|packageManager|main|module|types|license)"\s*:/.test(text)) return undefined
  const match = text.match(DEPENDENCY_LINE)
  return match?.[1] ?? match?.[2]
}

// ---- Which commands are checks, and does their exit code mean anything ------------------------------------------------

const CHECK_RULES: [CheckKind, RegExp][] = [
  [
    "test",
    /\b(?:(?:bun|npm|pnpm|yarn|deno|bunx|npx)\s+(?:run\s+)?(?:\S*test\S*|vitest|jest|mocha)|vitest|jest|pytest|py\.test|go\s+test|cargo\s+(?:nextest|test)|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*\S*test\S*|make\s+\S*test\S*|rspec|phpunit|dotnet\s+test|ctest)\b/,
  ],
  ["typecheck", /\b(?:tsc|tsgo|typecheck|type-check|mypy|pyright|cargo\s+check|go\s+vet)\b/],
  ["lint", /\b(?:\S*lint\b|biome\s+check|ruff|clippy|flake8|rubocop)/],
  [
    "build",
    /\b(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build|cargo\s+build|go\s+build|gradlew?\s+(?:\S+\s+)*build|mvn\s+(?:\S+\s+)*(?:package|install|verify)|vite\s+build|next\s+build)\b/,
  ],
]
const NOT_A_RUN = /^\s*(?:echo|printf|cat|grep|rg|git|ls|find|sed|awk|head|tail|which|cd)\b/
const PARTIAL_TEST =
  /\.(?:test|spec)\.\w+|_test\.\w+|test_\w+\.py|\s-t\s|--testNamePattern|--filter\b|\s-k\s|--grep\b|\s-run\s|--passWithNoTests/

export type ClassifiedCommand = { kinds: CheckKind[]; hidden: boolean; partial: boolean }

/**
 * `bun test | tail -5` and `bun test || true` both exit 0 whatever the tests did. A chain's exit code only speaks for a
 * check when nothing after it can replace that code, so anything else is reported as hidden rather than passed.
 */
export function classifyCommand(command: string): ClassifiedCommand | undefined {
  const pieces = command.split(/(\|\||&&|\|&|\||;|\n)/)
  const segments = pieces.filter((_, index) => index % 2 === 0)
  const operators = pieces.filter((_, index) => index % 2 === 1)
  const pipefail = /pipefail/.test(command)
  const errexit = /\bset\s+-\w*e/.test(command)
  const kinds = new Set<CheckKind>()
  let hidden = false
  let partial = false
  segments.forEach((segment, index) => {
    if (NOT_A_RUN.test(segment)) return
    const matched = CHECK_RULES.filter(([, rule]) => rule.test(segment)).map(([kind]) => kind)
    if (matched.length === 0) return
    matched.forEach((kind) => kinds.add(kind))
    if (matched.includes("test") && PARTIAL_TEST.test(segment)) partial = true
    for (let next = index; next < operators.length; next += 1) {
      const operator = operators[next]
      if (!segments[next + 1]?.trim()) continue
      if (operator === "&&") continue
      if ((operator === "|" || operator === "|&") && pipefail) continue
      if ((operator === ";" || operator === "\n") && errexit) continue
      hidden = true
      break
    }
  })
  if (kinds.size === 0) return
  return { kinds: [...kinds], hidden, partial }
}

// ---- What the run did, per file and per check --------------------------------------------------------------------------

export type CheckRun = {
  kind: CheckKind
  command: string
  status: CheckStatus
  partial: boolean
  exit?: number
  at: number
  step: MapStep
  sessionID: string
}

export type FileTouch = {
  file: string
  at: number
  sessionID: string
  step?: MapStep
  prompt?: string
  narration?: string
}

export type RunActivity = {
  touches: FileTouch[]
  checks: CheckRun[]
  closing?: string
  // False when the only record is that nothing was recorded: a session with no edits or patches cannot attribute a file.
  attributes: boolean
}

export type ActivitySession = {
  id: string
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  revertMessageID?: string
}

export function projectPath(path: string, roots: readonly string[]) {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "")
  for (const root of roots) {
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "")
    if (base && clean.startsWith(base + "/")) return clean.slice(base.length + 1)
  }
  return clean
}

export function buildActivity(input: {
  sessions: readonly ActivitySession[]
  roots: readonly string[]
  quiet?: <T>(read: () => T) => T
}): RunActivity {
  const touches: FileTouch[] = []
  const checks: CheckRun[] = []
  let attributes = false
  let closing: string | undefined

  input.sessions.forEach((session, sessionIndex) => {
    const map = buildSessionMap({
      messages: session.messages,
      parts: session.parts,
      revertMessageID: session.revertMessageID,
      quiet: input.quiet,
    })
    if (sessionIndex === 0) closing = map.chapters.at(-1)?.outcome?.text

    map.chapters.forEach((chapter) => {
      let narration: string | undefined
      chapter.steps.forEach((step) => {
        if (step.kind === "text") {
          narration = step.label
          return
        }
        if (step.kind === "command" && !step.notRun) {
          const classified = classifyCommand(String(step.input?.command ?? step.label))
          const exit = step.metadata?.exit
          classified?.kinds.forEach((kind) => {
            const status: CheckStatus = step.running
              ? "running"
              : step.problem
                ? "failed"
                : classified.hidden || typeof exit !== "number"
                  ? "hidden"
                  : "passed"
            checks.push({
              kind,
              command: String(step.input?.command ?? step.label),
              status,
              partial: classified.partial,
              exit: typeof exit === "number" ? exit : undefined,
              at: step.end ?? step.start,
              step,
              sessionID: session.id,
            })
          })
        }
        step.files.forEach((change) => {
          attributes = true
          touches.push({
            file: projectPath(change.path, input.roots),
            at: step.end ?? step.start,
            sessionID: session.id,
            step,
            prompt: chapter.prompt,
            narration,
          })
        })
      })

      // Patch parts are the snapshot's record of a finished step, which also catches files a shell command changed.
      const steps = new Map(chapter.steps.map((step) => [step.partID, step]))
      const replies = session.messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.parentID === chapter.id &&
          (!session.revertMessageID || message.id < session.revertMessageID),
      )
      replies.forEach((message) => {
        let last: MapStep | undefined
        let command: MapStep | undefined
        const edited = new Set<string>()
        session.parts(message.id).forEach((part) => {
          const known = steps.get(part.id)
          if (known && known.kind !== "text") {
            last = known
            if (known.kind === "command") command = known
            known.files.forEach((change) => edited.add(projectPath(change.path, input.roots)))
          }
          if (part.type !== "patch") return
          attributes = true
          // An edit tool already gave its exact time. What is left came from a command, so it dates from that command.
          const source = command ?? last
          part.files.forEach((path) => {
            const file = projectPath(path, input.roots)
            if (edited.has(file)) return
            touches.push({
              file,
              at: source ? (source.end ?? source.start) : message.time.created,
              sessionID: session.id,
              step: source,
              prompt: chapter.prompt,
            })
          })
        })
      })
    })
  })

  return {
    touches: touches.toSorted((a, b) => a.at - b.at),
    checks: checks.toSorted((a, b) => a.at - b.at),
    closing,
    attributes,
  }
}

// ---- What the agent said against what happened -----------------------------------------------------------------------

const CLAIMS: [CheckKind, RegExp][] = [
  [
    "test",
    /\b(?:tests?|specs?|test suite)\b[^.!?\n]{0,40}\b(?:pass|passes|passing|passed|green|succeed|succeeds)\b|\bpass(?:es|ing)?\b[^.!?\n]{0,20}\btests?\b/i,
  ],
  [
    "typecheck",
    /\b(?:type-?check|types?|tsc)\b[^.!?\n]{0,30}\b(?:pass|passes|passing|passed|clean|green)\b|\bno type errors\b/i,
  ],
  ["lint", /\blint\w*\b[^.!?\n]{0,30}\b(?:pass|passes|passing|passed|clean|green)\b/i],
  ["build", /\bbuild\w*\b[^.!?\n]{0,30}\b(?:pass|passes|passing|passed|succeed|succeeds|succeeded|clean|green)\b/i],
]
const HEDGE =
  /\b(?:not|n't|never|unable|cannot|can't|without|should|would|could|may|might|once|until|if|before|after you|please|need|needs|make sure|to ensure)\b/i

export type RunClaim = { kind: CheckKind; quote: string }

export function findClaims(text: string | undefined): RunClaim[] {
  if (!text) return []
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  const claims = new Map<CheckKind, RunClaim>()
  sentences.forEach((sentence) => {
    if (HEDGE.test(sentence)) return
    CLAIMS.forEach(([kind, rule]) => {
      if (rule.test(sentence) && !claims.has(kind)) claims.set(kind, { kind, quote: sentence.trim().slice(0, 140) })
    })
  })
  return [...claims.values()]
}

// ---- The brief ---------------------------------------------------------------------------------------------------------

export type BriefFile = {
  file: string
  additions: number
  deletions: number
  status: DiffInput["status"]
  group: BriefGroupID
  flags: Flag[]
  trait?: FileTrait
  assessed: boolean
  hash: string
  mark: FileMark
  touches: FileTouch[]
  editedAfterChecks: boolean
}

export type EvidenceRow =
  | {
      type: "check"
      kind: CheckKind
      status: CheckStatus | "stale"
      run: CheckRun
      // Files in this diff changed after this run ended, so the run says nothing about them.
      editedAfter: string[]
    }
  | { type: "none"; kinds: CheckKind[] }
  | { type: "claim"; claim: RunClaim; against: "failed" | "none"; run?: CheckRun }
  | { type: "untested"; files: string[] }
  | { type: "elsewhere"; files: string[] }

export type BriefHeadline =
  | { key: "working" }
  | { key: "failed"; command: string }
  | { key: "claim"; kind: CheckKind }
  | { key: "stale"; count: number }
  | { key: "hidden"; command: string }
  | { key: "unchecked" }
  | { key: "flags"; count: number }
  | { key: "clear" }
  | { key: "history" }
  | { key: "elsewhere"; count: number }

export type BriefTone = "critical" | "warning" | "ok" | "neutral"

export type Brief = {
  files: BriefFile[]
  byFile: Map<string, BriefFile>
  groups: { id: BriefGroupID; files: string[] }[]
  order: string[]
  evidence: EvidenceRow[]
  headline: BriefHeadline
  tone: BriefTone
  progress: { total: number; ok: number; work: number; changed: number; open: number }
  sendable: boolean
}

export type BriefInput = {
  diffs: readonly DiffInput[]
  activity: RunActivity
  marks: Record<string, ReviewMark | undefined>
  running: boolean
  // False until every session in the run has its full history here. Nothing may be claimed absent before that.
  complete: boolean
}

const GROUP_ORDER: BriefGroupID[] = ["look", "read", "skim", "elsewhere"]

const groupOf = (flags: Flag[], trait: FileTrait | undefined, fromRun: boolean): BriefGroupID => {
  if (flags.some((flag) => flag.severity !== "low")) return "look"
  if (!fromRun) return "elsewhere"
  if (trait) return "skim"
  return "read"
}

const markOf = (mark: ReviewMark | undefined, hash: string): FileMark => {
  if (!mark) return "none"
  return mark.hash === hash ? mark.verdict : "changed"
}

export function buildBrief(input: BriefInput): Brief {
  const allFiles = input.diffs.map((diff) => diff.file)
  const { touches, checks } = input.activity
  const attributable = input.activity.attributes && input.complete

  const latest = new Map<CheckKind, CheckRun>()
  checks.forEach((run) => {
    // A narrowed rerun of one file must not replace what the last full run said.
    const current = latest.get(run.kind)
    if (run.partial && current && !current.partial && current.status === "passed" && run.status === "passed") return
    latest.set(run.kind, run)
  })

  const inDiff = new Set(allFiles)
  const lastEdit = new Map<string, number>()
  touches.forEach((touch) => {
    if (inDiff.has(touch.file)) lastEdit.set(touch.file, Math.max(lastEdit.get(touch.file) ?? 0, touch.at))
  })
  const editedAfter = (at: number) =>
    [...lastEdit.entries()]
      .filter(([file, time]) => time > at && !DOC_FILE.test(file))
      .map(([file]) => file)
      .sort()

  const lastPass = Math.max(0, ...[...latest.values()].filter((run) => run.status === "passed").map((run) => run.at))

  const files = input.diffs.map((diff): BriefFile => {
    const assessment = assessFile(diff, allFiles)
    const own = touches.filter((touch) => touch.file === diff.file)
    const fromRun = !attributable || own.length > 0
    const hash = changeHash(diff)
    return {
      file: diff.file,
      additions: diff.additions,
      deletions: diff.deletions,
      status: diff.status,
      group: groupOf(assessment.flags, assessment.trait, fromRun),
      flags: assessment.flags,
      trait: assessment.trait,
      assessed: assessment.assessed,
      hash,
      mark: markOf(input.marks[diff.file], hash),
      touches: own,
      editedAfterChecks: lastPass > 0 && (lastEdit.get(diff.file) ?? 0) > lastPass,
    }
  })

  // Within a group: what a person flagged and the agent then changed comes first, then by severity, then by size.
  const rank = (file: BriefFile) => {
    const severity = file.flags.reduce((best, flag) => Math.min(best, SEVERITY_ORDER[flag.severity]), 3)
    return [file.mark === "changed" ? 0 : 1, severity, -(file.additions + file.deletions)]
  }
  const sorted = files.toSorted((a, b) => {
    const left = rank(a)
    const right = rank(b)
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || a.file.localeCompare(b.file)
  })
  const groups = GROUP_ORDER.map((id) => ({
    id,
    files: sorted.filter((file) => file.group === id).map((file) => file.file),
  })).filter((group) => group.files.length > 0)

  // ---- Evidence ----
  const evidence: EvidenceRow[] = []
  ;(["test", "typecheck", "lint", "build"] as CheckKind[]).forEach((kind) => {
    const run = latest.get(kind)
    if (!run) return
    const after = editedAfter(run.at)
    const status = run.status === "passed" && after.length > 0 ? "stale" : run.status
    evidence.push({ type: "check", kind, status, run, editedAfter: after })
  })
  const anyCode = files.some((file) => isCode(file.file) && file.group !== "elsewhere")
  if (input.complete && anyCode) {
    if (latest.size === 0) evidence.push({ type: "none", kinds: ["test", "typecheck", "build"] })
    else if (!latest.has("test")) evidence.push({ type: "none", kinds: ["test"] })
  }
  const claims = findClaims(input.activity.closing).flatMap((claim): EvidenceRow[] => {
    const run = latest.get(claim.kind)
    if (run?.status === "failed") return [{ type: "claim", claim, against: "failed", run }]
    if (!run && input.complete) return [{ type: "claim", claim, against: "none" }]
    return []
  })
  evidence.unshift(...claims)
  const changedCode = files.filter(
    (file) => isCode(file.file) && file.group !== "elsewhere" && file.status !== "deleted",
  )
  if (changedCode.length > 0 && !files.some((file) => isTestFile(file.file))) {
    evidence.push({ type: "untested", files: changedCode.map((file) => file.file) })
  }
  const elsewhere = files.filter((file) => attributable && file.touches.length === 0).map((file) => file.file)
  if (elsewhere.length > 0) evidence.push({ type: "elsewhere", files: elsewhere })

  // ---- Headline: the one thing that most changes the decision ----
  const rows = evidence.flatMap((row) => (row.type === "check" ? [row] : []))
  const failed = rows.find((row) => row.status === "failed")
  const stale = rows.flatMap((row) => (row.status === "stale" ? row.editedAfter : []))
  const hidden = rows.find((row) => row.status === "hidden")
  const none = evidence.some((row) => row.type === "none")
  const flagged = files.filter((file) => file.group === "look").length
  const contradicted = claims.length > 0 ? (claims[0] as Extract<EvidenceRow, { type: "claim" }>) : undefined

  const onlyElsewhere = files.length > 0 && files.every((file) => file.group === "elsewhere")

  let headline: BriefHeadline
  let tone: BriefTone
  if (input.running) {
    headline = { key: "working" }
    tone = "neutral"
  } else if (contradicted) {
    headline = { key: "claim", kind: contradicted.claim.kind }
    tone = "critical"
  } else if (failed) {
    headline = { key: "failed", command: failed.run.command }
    tone = "critical"
  } else if (onlyElsewhere) {
    // Nothing here is this run's: it landed, was undone or never existed. These files are not waiting for a review of it.
    headline = { key: "elsewhere", count: files.length }
    tone = "neutral"
  } else if (stale.length > 0) {
    headline = { key: "stale", count: new Set(stale).size }
    tone = "warning"
  } else if (hidden) {
    headline = { key: "hidden", command: hidden.run.command }
    tone = "warning"
  } else if (none) {
    headline = { key: "unchecked" }
    tone = "warning"
  } else if (!input.complete && rows.length === 0) {
    headline = { key: "history" }
    tone = "neutral"
  } else if (flagged > 0) {
    headline = { key: "flags", count: flagged }
    tone = "warning"
  } else {
    headline = { key: "clear" }
    tone = "ok"
  }

  const counted = (mark: FileMark) => files.filter((file) => file.mark === mark).length
  const progress = {
    total: files.length,
    ok: counted("ok"),
    work: counted("work"),
    changed: counted("changed"),
    open: counted("none") + counted("changed"),
  }

  return {
    files,
    byFile: new Map(files.map((file) => [file.file, file])),
    groups,
    order: groups.flatMap((group) => group.files),
    evidence: onlyElsewhere ? evidence.filter((row) => row.type !== "elsewhere") : evidence,
    headline,
    tone,
    progress,
    sendable: progress.work > 0 || !!failed || !!contradicted,
  }
}

/** The file to go to after a verdict: the next one needing a decision, wrapping once. */
export function nextOpenFile(brief: Pick<Brief, "order" | "byFile">, from: string | undefined) {
  const order = brief.order
  const start = from ? order.indexOf(from) : -1
  for (let offset = 1; offset <= order.length; offset += 1) {
    const file = order[(start + offset + order.length) % order.length]
    const mark = brief.byFile.get(file)?.mark
    if (file !== from && (mark === "none" || mark === "changed")) return file
  }
  return undefined
}

/** Every flagged line in a file in reading order, for stepping through them one key at a time. */
export function flaggedLines(file: Pick<BriefFile, "flags">) {
  const seen = new Set<string>()
  return file.flags
    .flatMap((flag) => flag.lines)
    .filter((line) => {
      const key = `${line.side}:${line.line}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .toSorted((a, b) => a.line - b.line)
}

// ---- Undo: run the patch backwards ----------------------------------------------------------------------------------

const UNREVERSIBLE = /^(?:rename |copy |similarity |dissimilarity |old mode|new mode|Binary files|GIT binary patch)/m

/**
 * Reverses a git-format patch of one file so `git apply` restores it. Returns undefined for anything it cannot reverse
 * exactly: renames, mode changes, binaries, non-git patches and patches with no hunks.
 */
export function reversePatch(patch: string): string | undefined {
  if (!patch.startsWith("diff --git ") || UNREVERSIBLE.test(patch.slice(0, patch.indexOf("@@ ") + 1 || undefined)))
    return
  const lines = patch.split("\n")
  const out: string[] = []
  let oldLeft = 0
  let newLeft = 0
  let hunks = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0]
      if (mark === "+") {
        out.push("-" + line.slice(1))
        newLeft -= 1
      } else if (mark === "-") {
        out.push("+" + line.slice(1))
        oldLeft -= 1
      } else if (mark === "\\") {
        out.push(line)
      } else {
        out.push(line)
        oldLeft -= 1
        newLeft -= 1
      }
      continue
    }
    const head = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (head) {
      const oldRange = `${head[1]}${head[2] === undefined ? "" : "," + head[2]}`
      const newRange = `${head[3]}${head[4] === undefined ? "" : "," + head[4]}`
      out.push(`@@ -${newRange} +${oldRange} @@${head[5]}`)
      oldLeft = head[2] === undefined ? 1 : Number(head[2])
      newLeft = head[4] === undefined ? 1 : Number(head[4])
      hunks += 1
      continue
    }
    if (line.startsWith("\\")) {
      out.push(line)
      continue
    }
    if (line.startsWith("new file mode ")) out.push(line.replace("new file mode ", "deleted file mode "))
    else if (line.startsWith("deleted file mode ")) out.push(line.replace("deleted file mode ", "new file mode "))
    else if (line.startsWith("index ")) out.push(line.replace(/^index (\w+)\.\.(\w+)/, "index $2..$1"))
    else if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const from = line.slice(4)
      const to = lines[index + 1].slice(4)
      out.push("--- " + (to === "/dev/null" ? to : to.replace(/^b\//, "a/")))
      out.push("+++ " + (from === "/dev/null" ? from : from.replace(/^a\//, "b/")))
      index += 1
    } else out.push(line)
  }
  return hunks > 0 ? out.join("\n") : undefined
}
