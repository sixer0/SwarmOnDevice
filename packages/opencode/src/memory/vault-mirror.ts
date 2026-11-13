// Vault mirror (N8-105, namespace VaultMirror): project memory, mission index entries and final reports as linked
// Obsidian notes under `<vault>/swarm-memory/<folder>/` (spec 01c §3-§4, 01_specs §5.2 and §5.6, AC-OBSc).
//
// This file holds the RENDER half (1.2.8 row 43b): `render` turns a memory store into the full set of files the folder
// should contain, as pure text with no clock read and no disk access, so golden files can pin it byte for byte.
// `readReport` is the one read it needs (a final report inside the project). Writing, ownership, renames and the
// symlink checks under the vault are the SYNC half (`sync`, row 43c, 01c §3.1-§3.2, SR8-12), which builds on `render`.
// When it runs (`schedule`, debounce, label language, the close nudge text) is the TRIGGER half (row 43d, 01c §5, §8.3).
//
// What reaches the vault is less than the store holds (01c §3.3): deviceOnly, secret-looking and classified items are
// never copied (only counted, L6); memory text is data, so every ASCII punctuation mark in it is backslash-escaped and
// nothing in it can become a link, embed, tag or HTML; report copies keep their Markdown but lose raw HTML, image
// auto-load, embeds, runnable code blocks and inline queries (SR8-13), and non-web link targets (SR8-13); a report that
// carries a classification word is link-only (SR8-14); secrets in a copied report are masked line by line.
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Vault } from "@opencode-ai/core/vault"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { Secrets } from "@/tool/secrets"
import { MemoryLearn } from "./learn"
import { MISSION_ID_PATTERN } from "./memory"

type Item = ProjectMemory.Item
type Ref = ProjectMemory.MemoryRef

/** N8-110: a report larger than this is a link-only note (L9), never cut. */
export const MIRROR_REPORT_MAX_BYTES = 262144

/** N8-438 (SR8-12, C7): every generated file name except the hub `index.md`. Checked before any path join. */
export const VAULT_NOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}-[0-9a-f]{6}\.md$/

/**
 * N8-439 (SR8-13): fence info strings that stay as they are in a report copy (Obsidian core only highlights them).
 * Any other info string, `mermaid`, `dataview`, `dataviewjs` included, becomes `text`.
 */
export const MIRROR_PLAIN_FENCE_LANGS: readonly string[] = [
  "",
  "text",
  "txt",
  "plain",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "css",
  "ts",
  "typescript",
  "tsx",
  "js",
  "javascript",
  "jsx",
  "py",
  "python",
  "sh",
  "bash",
  "zsh",
  "shell",
  "sql",
  "diff",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
]

/**
 * N8-440 (SR8-14): whole words, case-insensitive, that keep an item or a report out of the vault. Studio stores the
 * classification as free text (`classification TEXT NOT NULL`, datum-studio `store/migrations/0001_datum_studio_init.ts`;
 * schema `string` 1-64, `contract/schema/diagram.schema.ts`), so it has no enumerated set beyond these words: its
 * own fixtures use `TERBATAS`, and `SANGAT RAHASIA` contains `RAHASIA` as a whole word.
 */
export const MIRROR_CLASSIFIED_WORDS = ["TERBATAS", "RAHASIA", "CONFIDENTIAL", "RESTRICTED"] as const

export type Language = "en" | "id"
export type NoteKind = "note" | "mission" | "report" | "skill"

/** A final report as `readReport` found it: its text, too large (L9), or missing/outside/unreadable (L11). */
export type ReportSource =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "large" }
  | { readonly status: "missing" }

export interface RenderInput {
  /** The memory store key (`swarm-key`); a hash or project id, never a path. */
  readonly key: string
  /** The project folder name (`Vault.vaultProjectFolder`). */
  readonly folder: string
  /** Shown in the hub heading and as the hub alias. */
  readonly projectName: string
  /** Label language; absent = Indonesian (OP-3 tier 3; tier 2 is empty in 1.2.8). */
  readonly language?: Language
  readonly items: readonly Item[]
  /** Final reports read by `readReport`, keyed by the report path as written in the index entry. */
  readonly reports?: Readonly<Record<string, ReportSource>>
}

export interface RenderedFile {
  /** Relative to the project folder: `index.md`, `notes/<name>.md`, `missions/…`, `reports/…`, `skills/…`. */
  readonly path: string
  readonly content: string
}

export interface RenderResult {
  /** Sorted by path. */
  readonly files: readonly RenderedFile[]
  /** Items not copied: kept on this device, secret-looking, classified, or with an unsafe id (the L6 count). */
  readonly notCopied: number
  /** Of those, the items skipped for an id or name that failed its pattern (`VAULT_PATH_UNSAFE`). */
  readonly unsafe: number
}

// ---------------------------------------------------------------------------------------------------------------
// Labels (01c §4.5 with N8-435). Generated text only: memory content is never translated.

const LABELS = {
  en: {
    hubTitle: (name: string) => `# ${name}: Swarm memory`,
    banner:
      "Generated by Swarm from project memory. Edit the memory in Swarm, not this note: an edited note is no longer updated.",
    missions: "## Missions",
    notes: "## Notes",
    skills: "## Skills",
    notCopied: (n: number) =>
      `${n} notes are not copied here: kept on this device only, secret-looking, or marked as classified.`,
    related: "## Related",
    untrusted:
      "> [!warning] Written after the session read web, MCP, Studio or files outside the project. Check before relying on it.",
    large: (p: string) => `This report is larger than 256 KB and is not copied here. Open it at ${p}.`,
    classified: (p: string) => `This report is marked as classified and is not copied here. Open it at ${p}.`,
    missing: (p: string) =>
      `The report file is missing, outside this project or unreadable, so it is not copied here. Path: ${p}.`,
    reports: "## Reports",
    detail: "Detail",
    references: "References",
    report: "Report",
    mission: "Mission",
    project: "Project",
  },
  id: {
    hubTitle: (name: string) => `# ${name}: memori Swarm`,
    banner:
      "Dibuat oleh Swarm dari memori proyek. Ubah memorinya di Swarm, bukan catatan ini: catatan yang diubah tidak diperbarui lagi.",
    missions: "## Misi",
    notes: "## Catatan",
    skills: "## Keahlian",
    notCopied: (n: number) =>
      `${n} catatan tidak disalin ke sini: hanya di perangkat ini, tampak berisi rahasia, atau ditandai sebagai dokumen berklasifikasi.`,
    related: "## Terkait",
    untrusted:
      "> [!warning] Ditulis setelah sesi membaca web, MCP, Studio, atau berkas di luar proyek. Periksa sebelum mengandalkannya.",
    large: (p: string) => `Laporan ini lebih besar dari 256 KB dan tidak disalin ke sini. Buka di ${p}.`,
    classified: (p: string) =>
      `Laporan ini ditandai sebagai dokumen berklasifikasi dan tidak disalin ke sini. Buka di ${p}.`,
    missing: (p: string) =>
      `Berkas laporan tidak ada, berada di luar proyek ini, atau tidak dapat dibaca, jadi tidak disalin ke sini. Lokasi: ${p}.`,
    reports: "## Laporan",
    detail: "Rincian",
    references: "Rujukan",
    report: "Laporan",
    mission: "Misi",
    project: "Proyek",
  },
} as const

// ---------------------------------------------------------------------------------------------------------------
// Names (01_specs §5.2, N8-432 noteName)

const NAME_MAX = 60
const REPORT_SUFFIX = "-report"
const HEX6 = /^[0-9a-f]{6}$/
// Item ids are 6 hex today (`randomBytes(3)`); store-written ids (roll-ups) and older stores may differ, so any id made
// of these characters is accepted. It is never joined into a path (the file name is folded), but it is written as the
// link label and `swarm-id`, so nothing that could end a wikilink or a YAML string may pass.
const ITEM_ID = /^[0-9A-Za-z_-]{1,64}$/
const FOLDER = /^[a-z0-9][a-z0-9-]{0,80}$/
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
// SK-f (N8-046): `Skill <name> (<scope>): <description>. Triggers: …`
const SKILL_NOTE = /^Skill (\S+) \(([a-z]+)\): /
const ROLLUP_MEMBER = /^\[[^\]\s]+\] /

let missionPattern: RegExp | undefined
// Built on first use, not at load: memory.ts may import this module later (row 43d), and a load-time read of its
// constant would then run before it is defined.
const missionIdOk = (id: string) => (missionPattern ??= new RegExp(MISSION_ID_PATTERN)).test(id)

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function fold(source: string, max: number): string {
  const s = source
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1).lastIndexOf("-")
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, max)).replace(/-+$/, "")
}

/**
 * N8-432: the file name (with `.md`) of a generated note, or undefined when it does not match
 * `VAULT_NOTE_NAME_PATTERN` (the caller skips the item with `VAULT_PATH_UNSAFE`).
 * - `note`: `source` = the item text (its first line is the slug source); id part = the id when it is 6 hex, else the
 *   first 6 hex of sha256(id).
 * - `mission`: `id` = the mission id; `report`: `id` = the mission id, slug `<mission slug>-report` (the slug is cut
 *   first so the suffix survives) with the mission's id part; `skill`: `id` = the skill name.
 */
export function noteName(kind: NoteKind, id: string, source?: string): string | undefined {
  const h6 = kind === "note" && HEX6.test(id) ? id : sha256(id).slice(0, 6)
  const raw = kind === "note" ? (source ?? "").split("\n")[0]! : id
  const slug =
    kind === "report"
      ? (fold(raw, NAME_MAX - REPORT_SUFFIX.length) || "mission") + REPORT_SUFFIX
      : fold(raw, NAME_MAX) || kind
  const name = `${slug}-${h6}.md`
  return VAULT_NOTE_NAME_PATTERN.test(name) ? name : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Exclusion (01c §3.3, SR8-14)

const CLASSIFIED = new RegExp(`\\b(?:${MIRROR_CLASSIFIED_WORDS.join("|")})\\b`, "i")

/** True when the text carries a classification word of `MIRROR_CLASSIFIED_WORDS` as a whole word. */
export const classified = (text: string) => CLASSIFIED.test(text)

const refStrings = (item: Item) =>
  (item.refs ?? []).flatMap((ref) => ("symbol" in ref ? [ref.symbol, ref.path ?? ""] : [ref.path]))

function excluded(item: Item) {
  if (item.deviceOnly) return true
  const strings = [item.text, item.body ?? "", ...refStrings(item)]
  return strings.some((value) => value !== "" && (MemoryLearn.looksSecret(value) || classified(value)))
}

// ---------------------------------------------------------------------------------------------------------------
// Escaping (01c §4.4): memory text is data

/** Every ASCII punctuation character backslash-escaped (CommonMark), newlines kept. */
export function escapeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[!-/:-@[-`{-~]/g, "\\$&")
}

/** Wikilink display text: nothing that can end the link, start a heading/block ref, or break the line. */
const linkLabel = (text: string, fallback: string) =>
  text.replace(/[[\]|#^\\<>\r\n]+/g, " ").replace(/\s+/g, " ").trim() || fallback

/**
 * G2-01 (row 43f): a ref outside the project is shown as `~/...` under the home folder, else by its basename; the vault
 * is read by Obsidian plugins and sync (SR8-20), so it never carries the home folder or another absolute path.
 */
function refPath(value: string) {
  if (!path.isAbsolute(value)) return value
  const home = Global.Path.home
  const relative = home && path.isAbsolute(home) ? path.relative(home, value) : ""
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    return "~/" + relative.split(path.sep).join("/")
  return path.basename(value)
}

function refLabel(ref: Ref) {
  if ("symbol" in ref) return ref.path ? `${ref.symbol} (${refPath(ref.path)})` : ref.symbol
  return ref.line ? `${refPath(ref.path)}:${ref.line}` : refPath(ref.path)
}

/** Defence in depth (G2-01): the home folder, raw or Markdown-escaped, becomes `~` in every rendered note. */
function withoutHome(text: string) {
  const home = Global.Path.home
  if (!home || !path.isAbsolute(home) || path.dirname(home) === home) return text
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tail = "(?![A-Za-z0-9_-])"
  return text
    .replace(new RegExp(literal(escapeText(home)) + tail, "g"), escapeText("~"))
    .replace(new RegExp(literal(home) + tail, "g"), "~")
}

// ---------------------------------------------------------------------------------------------------------------
// Report neutralising (01c §4.4 + SR8-13), then masking (01c §3.3)

const WEB_SCHEMES = new Set(["http", "https", "mailto"])
const PLAIN_LANGS = new Set(MIRROR_PLAIN_FENCE_LANGS)

/** The destination as a browser would see it: entities and backslash escapes decoded, whitespace and controls gone. */
function decodedTarget(target: string) {
  const decoded = target
    .replace(/^<|>$/g, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000))
    .replace(/&#(\d{1,7});?/g, (_, dec: string) => String.fromCodePoint(Number(dec) % 0x110000))
    .replace(/&colon;/gi, ":")
    .replace(/&(?:tab|newline);/gi, "")
  return decoded.replace(/[\s\u0000-\u001f\u007f]+/g, "")
}

/** A link destination that is not a web or mail address (or that hides its scheme in an unknown entity). */
function unsafeTarget(target: string) {
  const decoded = decodedTarget(target)
  const head = decoded.split(/[/?#]/)[0]!
  if (/&[a-z][a-z0-9]*;/i.test(head)) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)
  return scheme !== null && !WEB_SCHEMES.has(scheme[1]!.toLowerCase())
}

/**
 * Plain report text outside code: images lose `!` (nothing is fetched), embeds become links, a link or reference
 * definition whose target is not http/https/mailto is written as escaped text, a non-web `scheme://` or script scheme
 * cannot be auto-linked, and `<` can no longer open HTML.
 */
function neutraliseText(text: string): string {
  return (
    text
      .replace(/!(?=\[)/g, "")
      // `](target` and `]: target`; a destination may follow on the next line, so a bare `](` or `]:` at the end of a
      // segment is broken as well.
      .replace(/\]([(:])([ \t]*)(<[^>\n]*>?|[^\s)]*)/g, (whole, open: string, space: string, target: string) => {
        if (target === "" || unsafeTarget(target)) return `]\\${open}${space}${escapeText(target)}`
        return whole
      })
      .replace(/\b([a-z][a-z0-9+.-]*):(?=\/\/)/gi, (whole, scheme: string) =>
        WEB_SCHEMES.has(scheme.toLowerCase()) ? whole : `${scheme}\\:`,
      )
      .replace(/\b(javascript|vbscript|data|file|obsidian):/gi, "$1\\:")
      .replace(/</g, "&lt;")
  )
}

/** Inline code whose content starts with `=` or `$=` (Dataview queries) gets a leading space so it stays text. */
function neutraliseCode(content: string): string {
  const stripped = content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== ""
  const effective = stripped ? content.slice(1, -1) : content
  if (!/^\$?=/.test(effective)) return content
  // A content that ends in a space would be stripped again on both sides, so two spaces keep one.
  return (effective.endsWith(" ") ? "  " : " ") + effective
}

/**
 * One line outside fences. Code spans are matched line by line, as CommonMark matches them when nothing earlier in
 * the paragraph is left open; `whole` is set once an earlier backtick run in the paragraph had no closer, and then the
 * line is treated as text throughout (a span could then pair differently, so nothing is left unneutralised).
 */
function neutraliseLine(line: string, whole: boolean): { text: string; open: boolean } {
  if (whole) return { text: neutraliseText(line), open: true }
  let out = ""
  let start = 0
  let open = false
  let i = 0
  while (i < line.length) {
    if (line[i] !== "`") {
      i++
      continue
    }
    let backslashes = 0
    for (let b = i - 1; b >= 0 && line[b] === "\\"; b--) backslashes++
    if (backslashes % 2 === 1) {
      i++
      continue
    }
    let j = i
    while (line[j] === "`") j++
    const n = j - i
    let k = j
    let close = -1
    while (k < line.length) {
      if (line[k] !== "`") {
        k++
        continue
      }
      let m = k
      while (line[m] === "`") m++
      if (m - k === n) {
        close = k
        break
      }
      k = m
    }
    if (close < 0) {
      open = true
      i = j
      continue
    }
    out += neutraliseText(line.slice(start, i)) + "`".repeat(n) + neutraliseCode(line.slice(j, close)) + "`".repeat(n)
    i = close + n
    start = i
  }
  out += neutraliseText(line.slice(start))
  return { text: out, open }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
// S-02 (row 43i): a fence after any container prefix — block quote or callout markers, list markers, continuation
// indentation of any width — in any order and depth. Each repeat ends on a marker character, so a run of blanks can be
// taken in one way only (no backtracking blow-up on long lines).
const NESTED_FENCE_OPEN = /^((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*)(`{3,}|~{3,})(.*)$/
const PLACEHOLDERS = new RegExp(Secrets.PLACEHOLDER.source, "g")

/**
 * A fence opened inside a container (`> ```dataviewjs`, `- ```dataviewjs`, an indented continuation) that the
 * top-level pass does not see: its info string becomes `text` unless it is on `MIRROR_PLAIN_FENCE_LANGS`. The line is
 * otherwise kept, so a plain nested fence and its container are unchanged.
 */
function neutraliseNestedFence(line: string): string {
  const fence = NESTED_FENCE_OPEN.exec(line)
  if (!fence) return line
  const [, prefix, mark, info] = fence as unknown as [string, string, string, string]
  if (mark.startsWith("`") && info.includes("`")) return line
  const lang = info.trim().split(/\s+/)[0]!.toLowerCase()
  return PLAIN_LANGS.has(lang) ? line : prefix + mark + "text"
}

/**
 * Report Markdown made safe to open in Obsidian. Every fence is written again at column 0, longer than any run of its
 * character inside, so Obsidian sees exactly the fences seen here; its info string is kept only when it is on
 * `MIRROR_PLAIN_FENCE_LANGS`, else `text`; a fence opened inside a quote, callout or list keeps its place and gets the
 * same info string rule (S-02). Then every line passes the secret masking: `Secrets.scrubText`, and a line
 * that still looks secret becomes `[hidden]` (masked, never cut: the line count is kept).
 */
export function neutraliseReport(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let whole = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE_OPEN.exec(line)
    if (fence && !(fence[1]!.startsWith("`") && fence[2]!.includes("`"))) {
      const char = fence[1]![0]!
      const size = fence[1]!.length
      const close = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${size},}[ \\t]*$`)
      let end = i + 1
      while (end < lines.length && !close.test(lines[end]!)) end++
      const body = lines.slice(i + 1, end)
      const lang = fence[2]!.trim().split(/\s+/)[0]!.toLowerCase()
      const longest = Math.max(0, ...body.map((l) => Math.max(0, ...(l.match(/`+|~+/g) ?? []).map((r) => r.length))))
      const mark = "`".repeat(Math.max(3, longest + 1))
      out.push(mark + (PLAIN_LANGS.has(lang) ? lang : "text"), ...body, mark)
      i = end + 1
      whole = false
      continue
    }
    if (line.trim() === "") whole = false
    const next = neutraliseLine(neutraliseNestedFence(line), whole)
    whole = whole || next.open
    out.push(next.text)
    i++
  }
  return out
    .map((line) => {
      const masked = Secrets.scrubText(line)
      // The placeholder itself (`password=[hidden:password]`) is not a secret; what is left around it is checked.
      return MemoryLearn.looksSecret(masked.replace(PLACEHOLDERS, "")) ? "[hidden]" : masked
    })
    .join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Report reading (01c §3.3 report rule)

/**
 * The report path of an index entry: group 5 of `INDEX_TEXT_PATTERN` (N8-005), else the first ref's path.
 */
export function reportPath(item: Item): string | undefined {
  const match = ProjectMemory.INDEX_TEXT_PATTERN.exec(item.text)
  if (match) return match[5]
  const ref = item.refs?.[0]
  return ref && !("symbol" in ref) ? ref.path : undefined
}

/**
 * Reads a final report for the mirror: only a regular `.md` file, not a symlink, whose real path lies inside the real
 * project root, at most `MIRROR_REPORT_MAX_BYTES`. Anything else is `missing` (L11) or `large` (L9). Reads only.
 */
export async function readReport(projectRoot: string, relPath: string): Promise<ReportSource> {
  const missing = { status: "missing" } as const
  if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0") || path.isAbsolute(relPath)) return missing
  if (!relPath.endsWith(".md")) return missing
  try {
    const rootReal = await fs.realpath(projectRoot)
    const target = path.resolve(rootReal, relPath)
    if (!Vault.contains(rootReal, target)) return missing
    const link = await fs.lstat(target)
    if (link.isSymbolicLink() || !link.isFile()) return missing
    const real = await fs.realpath(target)
    if (!Vault.contains(rootReal, real) || !real.endsWith(".md")) return missing
    if (link.size > MIRROR_REPORT_MAX_BYTES) return { status: "large" }
    const text = await fs.readFile(real, "utf8")
    if (Buffer.byteLength(text) > MIRROR_REPORT_MAX_BYTES) return { status: "large" }
    return { status: "ok", text }
  } catch {
    return missing
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Render (01c §4, A1: pure, sorted, no clock)

type Source = "user" | "agent" | "learned" | "index" | "report" | "skill"

interface Note {
  readonly dir: "notes" | "missions" | "reports" | "skills"
  readonly name: string // file name without `.md`
  readonly id: string // swarm-id, also the link label
  readonly time: number
}

const TAG = {
  note: "swarm-memory/note",
  index: "swarm-memory/index",
  report: "swarm-memory/report",
  skill: "swarm-memory/skill",
  untrusted: "swarm-memory/untrusted",
  mission: (id: string) => `swarm-memory/mission/${id}`,
}

function frontmatter(input: {
  key: string
  id: string
  source: Source
  hash: string
  lang?: Language
  tags: readonly string[]
  aliases?: readonly string[]
}) {
  const lines = [
    "---",
    "swarm-mirror: true",
    `swarm-key: ${JSON.stringify(input.key)}`,
    `swarm-id: ${JSON.stringify(input.id)}`,
    `swarm-source: ${JSON.stringify(input.source)}`,
    `swarm-hash: ${JSON.stringify(input.hash)}`,
  ]
  if (input.lang) lines.push(`swarm-lang: ${JSON.stringify(input.lang)}`)
  lines.push("tags:", ...input.tags.map((tag) => `  - ${JSON.stringify(tag)}`))
  if (input.aliases?.length) lines.push("aliases:", ...input.aliases.map((alias) => `  - ${JSON.stringify(alias)}`))
  lines.push("---")
  return lines.join("\n") + "\n"
}

/** sha256 of the body below the frontmatter, first 16 hex (N8-433). */
export const bodyHash = (body: string) => sha256(body).slice(0, 16)

const sharesRef = (a: Item, b: Item) =>
  (a.refs ?? []).some((ra) =>
    (b.refs ?? []).some((rb) => {
      if (ra.path && rb.path && ra.path === rb.path) return true
      if ("symbol" in ra && "symbol" in rb && ra.symbol === rb.symbol) return !ra.path || !rb.path
      return false
    }),
  )

const sameSession = (a: Item, b: Item) => a.sessionID !== undefined && a.sessionID === b.sessionID

const newestFirst = (a: { time: number; id: string }, b: { time: number; id: string }) =>
  b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const RELATED_MAX = 10

export function render(input: RenderInput): RenderResult {
  if (!FOLDER.test(input.folder)) return { files: [], notCopied: input.items.length, unsafe: input.items.length }
  const lang: Language = input.language ?? "id"
  const L = LABELS[lang]
  const base = `swarm-memory/${input.folder}`
  const link = (note: Note) => `[[${base}/${note.dir}/${note.name}|${note.id}]]`
  const projectLabel = linkLabel(input.projectName, input.folder)
  const hubLink = `**${L.project}**: [[${base}/index|${projectLabel}]]`

  let notCopied = 0
  let unsafe = 0
  const skip = (isUnsafe: boolean) => {
    notCopied++
    if (isUnsafe) unsafe++
  }

  // Classify the items. Archived index entries (rolledInto) are represented by their roll-up and add nothing.
  type Plain = { item: Item; note: Note }
  type Skill = { item: Item; note: Note; skill: string }
  type Mission = { item?: Item; line: string; note: Note; report?: { note: Note; path?: string }; rollup?: Note }
  const plain: Plain[] = []
  const rollups: (Plain & { missions: string[] })[] = []
  const skills: Skill[] = []
  const missions = new Map<string, Mission>()

  for (const item of input.items) {
    if (item.rolledInto !== undefined && item.kind !== "index_rollup") continue
    if (excluded(item)) {
      skip(false)
      continue
    }
    if (!ITEM_ID.test(item.id)) {
      skip(true)
      continue
    }
    if (item.kind === "index") {
      const missionId = item.missionId
      const missionName = missionId && missionIdOk(missionId) ? noteName("mission", missionId) : undefined
      const reportName = missionId && missionName ? noteName("report", missionId) : undefined
      if (!missionId || !missionName || !reportName || missions.has(missionId)) {
        skip(true)
        continue
      }
      missions.set(missionId, {
        item,
        line: item.text,
        note: { dir: "missions", name: missionName.slice(0, -3), id: missionId, time: item.time },
        report: {
          note: { dir: "reports", name: reportName.slice(0, -3), id: `${missionId}${REPORT_SUFFIX}`, time: item.time },
          path: reportPath(item),
        },
      })
      continue
    }
    const skillMatch = item.kind === undefined ? SKILL_NOTE.exec(item.text) : null
    if (skillMatch && SKILL_NAME.test(skillMatch[1]!)) {
      const name = noteName("skill", skillMatch[1]!)
      if (!name) {
        skip(true)
        continue
      }
      skills.push({ item, skill: skillMatch[1]!, note: { dir: "skills", name: name.slice(0, -3), id: skillMatch[1]!, time: item.time } })
      continue
    }
    const name = noteName("note", item.id, item.text)
    if (!name) {
      skip(true)
      continue
    }
    const note: Note = { dir: "notes", name: name.slice(0, -3), id: item.id, time: item.time }
    if (item.kind === "index_rollup") {
      const named = (item.body ?? "")
        .split("\n")
        .map((line) => ProjectMemory.INDEX_TEXT_PATTERN.exec(line.replace(ROLLUP_MEMBER, "")))
        .flatMap((match) => (match && missionIdOk(match[2]!) ? [{ id: match[2]!, line: match[0] }] : []))
      rollups.push({ item, note, missions: [...new Set(named.map((entry) => entry.id))] })
      for (const entry of named) {
        if (missions.has(entry.id)) continue
        const missionName = noteName("mission", entry.id)
        if (!missionName) continue
        missions.set(entry.id, {
          line: entry.line,
          note: { dir: "missions", name: missionName.slice(0, -3), id: entry.id, time: item.time },
          rollup: note,
        })
      }
      continue
    }
    plain.push({ item, note })
  }
  // A live index entry read after a roll-up that named the same mission takes its place.
  for (const rollup of rollups)
    for (const id of rollup.missions) {
      const mission = missions.get(id)
      if (mission && mission.item && !mission.rollup) missions.set(id, { ...mission, rollup: rollup.note })
    }

  const files: RenderedFile[] = []
  const emit = (note: Note | undefined, meta: Omit<Parameters<typeof frontmatter>[0], "hash" | "key">, lines: string[]) => {
    const body = withoutHome(lines.join("\n") + "\n")
    const file = note ? `${note.dir}/${note.name}.md` : "index.md"
    files.push({ path: file, content: withoutHome(frontmatter({ ...meta, key: input.key, hash: bodyHash(body) })) + body })
  }
  const head = (untrusted: boolean | undefined) => [hubLink, "", L.banner, "", ...(untrusted ? [L.untrusted, ""] : [])]
  const section = (title: string, notes: readonly Note[]) => (notes.length ? ["", title, ...notes.map((n) => `- ${link(n)}`)] : [])
  const detail = (item: Item) => [
    ...(item.body ? ["", `**${L.detail}**:`, "", escapeText(item.body)] : []),
    ...(item.refs?.length ? ["", `**${L.references}**:`, ...item.refs.map((ref) => `- ${escapeText(refLabel(ref))}`)] : []),
  ]
  const missionList = [...missions.values()].sort((a, b) => (a.note.id < b.note.id ? -1 : 1))

  // Ordinary notes and skill notes: related notes by shared ref or session, plus missions of the same session.
  const everyNote = [...plain, ...skills]
  for (const entry of everyNote) {
    const related = [
      ...everyNote.filter((other) => other !== entry && (sharesRef(entry.item, other.item) || sameSession(entry.item, other.item))).map((o) => o.note),
      ...missionList.filter((m) => m.item && sameSession(entry.item, m.item)).map((m) => m.note),
    ]
      .sort(newestFirst)
      .slice(0, RELATED_MAX)
    const skill = "skill" in entry
    emit(
      entry.note,
      {
        id: entry.note.id,
        source: skill ? "skill" : entry.item.source,
        tags: [skill ? TAG.skill : TAG.note, ...(entry.item.untrusted ? [TAG.untrusted] : [])],
      },
      [...head(entry.item.untrusted), escapeText(entry.item.text), ...detail(entry.item), ...section(L.related, related)],
    )
  }

  for (const rollup of rollups) {
    const named = rollup.missions.flatMap((id) => (missions.get(id) ? [missions.get(id)!.note] : []))
    emit(
      rollup.note,
      {
        id: rollup.note.id,
        source: "index",
        tags: [TAG.index, ...rollup.missions.map(TAG.mission), ...(rollup.item.untrusted ? [TAG.untrusted] : [])],
      },
      [...head(rollup.item.untrusted), escapeText(rollup.item.text), ...detail(rollup.item), ...section(L.missions, named)],
    )
  }

  for (const mission of missionList) {
    const item = mission.item
    const words = item ? `${item.text}\n${item.body ?? ""}` : ""
    const related = item
      ? [
          ...skills
            .filter((s) => sameSession(item, s.item) || new RegExp(`(^|[^a-z0-9-])${s.skill}($|[^a-z0-9-])`).test(words))
            .map((s) => s.note),
          ...plain.filter((p) => sameSession(item, p.item)).map((p) => p.note),
        ]
          .sort(newestFirst)
          .slice(0, RELATED_MAX)
      : []
    const untrusted = item?.untrusted
    const tags = [TAG.index, TAG.mission(mission.note.id), ...(untrusted ? [TAG.untrusted] : [])]
    emit(mission.note, { id: mission.note.id, source: "index", tags, aliases: [mission.note.id] }, [
      ...head(untrusted),
      escapeText(mission.line),
      ...(item ? detail({ ...item, refs: undefined }) : []),
      ...(mission.report ? ["", `**${L.report}**: ${link(mission.report.note)}`] : []),
      ...section(L.related, mission.rollup ? [mission.rollup, ...related].slice(0, RELATED_MAX) : related),
    ])
    if (!mission.report) continue
    const where = mission.report.path ?? ""
    const shown = escapeText(where)
    const found = input.reports?.[where] ?? ({ status: "missing" } as const)
    const content =
      found.status === "large" || (found.status === "ok" && Buffer.byteLength(found.text) > MIRROR_REPORT_MAX_BYTES)
        ? L.large(shown)
        : found.status === "missing" || where === ""
          ? L.missing(shown)
          : classified(found.text)
            ? L.classified(shown)
            : neutraliseReport(found.text)
    emit(
      mission.report.note,
      { id: mission.report.note.id, source: "report", tags: [TAG.report, TAG.mission(mission.note.id), ...(untrusted ? [TAG.untrusted] : [])] },
      [...head(untrusted), `**${L.mission}**: ${link(mission.note)}`, "", content],
    )
  }

  // The hub (01c §4.6): every mission, report, note and skill of the folder, then the not-copied count.
  const firstLine = (text: string) => escapeText(text.split(/\r?\n/)[0]!)
  const byId = <T extends { note: Note }>(list: readonly T[]) => [...list].sort((a, b) => (a.note.id < b.note.id ? -1 : 1))
  const noteLines = byId([...plain, ...rollups]).map((entry) => `- ${link(entry.note)} ${firstLine(entry.item.text)}`)
  emit(undefined, { id: "index", source: "index", lang, tags: [TAG.index], aliases: [input.projectName] }, [
    L.hubTitle(escapeText(input.projectName.replace(/\s+/g, " ").trim())),
    "",
    L.banner,
    ...section(L.missions, missionList.map((m) => m.note)),
    ...section(L.reports, missionList.flatMap((m) => (m.report ? [m.report.note] : []))),
    ...(noteLines.length ? ["", L.notes, ...noteLines] : []),
    ...section(L.skills, byId(skills).map((s) => s.note)),
    ...(notCopied ? ["", L.notCopied(notCopied)] : []),
  ])

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, notCopied, unsafe }
}

// ---------------------------------------------------------------------------------------------------------------
// Sync (01c §3.1-§3.2, SR8-12; 1.2.8 row 43c)
//
// Writes the rendered set under `realpath(Vault.root())/swarm-memory/<folder>/` and nowhere else: `index.md` and regular
// `.md` files in `notes/`, `missions/`, `reports/`, `skills/`, only files Swarm owns. The vault root is never created.
// A symlink (or a non-directory) at `swarm-memory`, the folder, a subfolder, or any file the run reads, writes or deletes
// refuses the whole run (`VAULT_PATH_UNSAFE`) before anything is written. Every write is a temp file opened exclusive
// (`wx`, mode 0600) in the target's folder and renamed over the target; the folder chain is re-`lstat`ed (same device
// and inode as at the check) before the temp file is opened and again before the rename, and after the open and after
// the rename the real path of the file must lie under the real project folder, else that file is removed and the run
// stops with `VAULT_PATH_UNSAFE`. A component swapped for a symlink between a check and a write therefore never leaves
// a file outside the folder (SR8-12).

export type SyncCode = "VAULT_PATH_UNSAFE" | "VAULT_NOTE_FOREIGN"

/** Note paths already reported as VAULT_NOTE_FOREIGN in this process (absolute key; the log stays relative, C108). */
const foreignLogged = new Set<string>()

/** Points in one write where a test hook can change the disk (SR8-12 swap test); never set in production. */
export type SyncStage = "temp" | "written" | "rename"

/** The file system calls `sync` makes; tests pass a wrapped `fs/promises` to count or interfere. */
export type SyncIO = Pick<typeof fs, "lstat" | "realpath" | "mkdir" | "chmod" | "readdir" | "readFile" | "open" | "rename" | "unlink">

export interface SyncInput {
  /** The memory store key (`Memory.storeKey`); also names the folder with `directory`. */
  readonly key: string
  /** The project folder the store belongs to (`Vault.vaultProjectFolder(directory, key)`). */
  readonly directory: string
  /** Where report paths of index entries start (worktree, or the folder for a project without git). */
  readonly projectRoot: string
  /** Hub heading; default the folder's base name. */
  readonly projectName?: string
  readonly language?: Language
  /** The store's items, read fresh by the caller. */
  readonly items: readonly Item[]
  /** The store's `enabled` flag; false (or `SWARM_DISABLE_MEMORY`) = the mirror does not run. */
  readonly enabled?: boolean
  readonly io?: SyncIO
  readonly hook?: (stage: SyncStage, target: string) => void | Promise<void>
  /** One call per refusal (`VAULT_PATH_UNSAFE` once per run, `VAULT_NOTE_FOREIGN` once per file). */
  readonly log?: (entry: { readonly code: SyncCode; readonly path: string; readonly reason: string }) => void
}

export interface SyncResult {
  /** ok; disabled; absent = no vault root; foreign-hub = `index.md` is the person's; unsafe = `VAULT_PATH_UNSAFE`. */
  readonly status: "ok" | "disabled" | "absent" | "foreign-hub" | "unsafe"
  readonly folder: string
  /** Paths relative to the project folder. */
  readonly written: readonly string[]
  readonly deleted: readonly string[]
  /** Target files left alone because they are not owned (`VAULT_NOTE_FOREIGN`). */
  readonly foreign: readonly string[]
  /** Rendered files dropped because their path failed the name check (`VAULT_PATH_UNSAFE`). */
  readonly skipped: number
  readonly notCopied: number
}

const HUB = "index.md"
const SUBFOLDERS: readonly string[] = ["notes", "missions", "reports", "skills"]
/** A temp file of an interrupted run: `.<name>.swarm-<pid>-<8 hex>.tmp`. */
const TEMP_FILE = /^\.[a-z0-9][a-z0-9.-]{0,80}\.swarm-\d{1,10}-[0-9a-f]{8}\.tmp$/

/** A log reason without absolute paths: the vault root becomes `<vault>`, any other absolute path `<path>`. */
function withoutPaths(reason: string, rootReal: string) {
  return reason
    .split(rootReal)
    .join("<vault>")
    .replace(/'(?:[A-Za-z]:)?[\\/][^']*'/g, "'<path>'")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]*/g, (match, offset: number, text: string) =>
      offset > 0 && /[\w.~>-]/.test(text[offset - 1]!) ? match : "<path>",
    )
}

class Unsafe extends Error {
  constructor(
    readonly at: string,
    readonly reason: string,
  ) {
    super(`VAULT_PATH_UNSAFE: ${reason}`)
  }
}

const missingError = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"

/** A rendered path is written only when it is the hub or `<subfolder>/<name matching N8-438>`. */
function safeRelative(rel: string) {
  if (rel === HUB) return true
  const parts = rel.split("/")
  return parts.length === 2 && SUBFOLDERS.includes(parts[0]!) && VAULT_NOTE_NAME_PATTERN.test(parts[1]!)
}

/**
 * Ownership triple (01c §3.1, N8-107, N8-433): `swarm-mirror: true`, `swarm-key` equal to this store's key, and
 * `swarm-hash` equal to the hash of the body as it is now. A note the person edited is no longer owned.
 */
export function owned(content: string, key: string): boolean {
  if (!content.startsWith("---\n")) return false
  const end = content.indexOf("\n---\n", 3)
  if (end < 0) return false
  const fields = new Map<string, string>()
  for (const line of content.slice(4, end).split("\n")) {
    const match = /^(swarm-[a-z]+):[ \t]*(.*)$/.exec(line)
    if (!match || fields.has(match[1]!)) continue
    let value: unknown = match[2]!.trim()
    if ((value as string).startsWith('"')) {
      try {
        value = JSON.parse(value as string)
      } catch {
        continue
      }
    }
    if (typeof value === "string") fields.set(match[1]!, value)
  }
  return (
    fields.get("swarm-mirror") === "true" &&
    fields.get("swarm-key") === key &&
    fields.get("swarm-hash") === bodyHash(content.slice(end + 5))
  )
}

/**
 * Mirror the store into the vault (01c §3.1-§3.2). Serialised per store across processes with
 * `Flock.withLock("vault-mirror:<key>")`. A second run on unchanged input writes and deletes nothing.
 */
export async function sync(input: SyncInput): Promise<SyncResult> {
  const folder = Vault.vaultProjectFolder(input.directory, input.key)
  if (input.enabled === false || process.env.SWARM_DISABLE_MEMORY)
    return { status: "disabled", folder, written: [], deleted: [], foreign: [], skipped: 0, notCopied: 0 }
  return Flock.withLock(`vault-mirror:${input.key}`, () => syncLocked(input, folder))
}

async function syncLocked(input: SyncInput, folder: string): Promise<SyncResult> {
  const io = input.io ?? fs
  const written: string[] = []
  const deleted: string[] = []
  const foreign: string[] = []
  let skipped = 0
  const result = (status: SyncResult["status"], notCopied = 0): SyncResult => ({
    status,
    folder,
    written,
    deleted,
    foreign,
    skipped,
    notCopied,
  })

  const rootReal = await Vault.realRoot()
  if (!rootReal) return result("absent")

  // Reports are read only inside the project (readReport), then the whole folder is rendered in memory.
  const reports = new Map<string, ReportSource>()
  for (const item of input.items) {
    if (item.kind !== "index") continue
    const where = reportPath(item)
    if (where !== undefined && !reports.has(where)) reports.set(where, await readReport(input.projectRoot, where))
  }
  const rendered = render({
    key: input.key,
    folder,
    projectName: input.projectName ?? path.basename(input.directory),
    language: input.language,
    items: input.items,
    reports: Object.fromEntries(reports),
  })
  const notCopied = rendered.notCopied

  const mirror = path.join(rootReal, Vault.VAULT_MIRROR_DIR)
  const folderPath = path.join(mirror, folder)
  // G2-02 (row 43f): the refusal is logged with the path inside the vault (`<vault>/...`) or its basename, and a reason
  // with every absolute path replaced (fs error messages carry them); never the home folder.
  const shown = (at: string) => {
    const relative = path.isAbsolute(at) ? path.relative(rootReal, at) : at
    if (!path.isAbsolute(at)) return at.split(path.sep).join("/")
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? "<vault>/" + relative.split(path.sep).join("/")
      : path.basename(at)
  }
  const unsafe = (at: string, reason: string) => {
    input.log?.({ code: "VAULT_PATH_UNSAFE", path: shown(at), reason: withoutPaths(reason, rootReal) })
    return result("unsafe", notCopied)
  }
  if (path.dirname(folderPath) !== mirror || !Vault.contains(rootReal, folderPath)) return unsafe(folderPath, "folder name")

  const desired = new Map<string, string>()
  for (const file of rendered.files) {
    if (safeRelative(file.path) && Vault.contains(folderPath, path.join(folderPath, file.path))) {
      desired.set(file.path, file.content)
      continue
    }
    skipped++
    input.log?.({ code: "VAULT_PATH_UNSAFE", path: file.path, reason: "name" })
  }

  // ---- Check: nothing is written before the whole tree we touch is known to hold no symlink.
  const dirStat = new Map<string, { dev: number; ino: number }>()
  const lstatOrNone = async (target: string) => {
    try {
      return await io.lstat(target)
    } catch (error) {
      if (missingError(error)) return undefined
      throw error
    }
  }
  const checkDir = async (target: string) => {
    const stat = await lstatOrNone(target)
    if (!stat) return false
    if (stat.isSymbolicLink()) throw new Unsafe(target, "symlink")
    if (!stat.isDirectory()) throw new Unsafe(target, "not a directory")
    dirStat.set(target, { dev: stat.dev, ino: stat.ino })
    return true
  }
  const logForeign = (rel: string, reason: string) => {
    if (!input.log) return
    const key = path.join(folderPath, rel)
    if (foreignLogged.has(key)) return
    foreignLogged.add(key)
    input.log({ code: "VAULT_NOTE_FOREIGN", path: rel, reason })
  }
  const subPath = (sub: string) => path.join(folderPath, sub)
  const dirOf = (rel: string) => (rel === HUB ? folderPath : subPath(path.dirname(rel)))
  const chain = (dir: string) => (dir === folderPath ? [mirror, folderPath] : [mirror, folderPath, dir])

  /** rel -> current content of a regular file; foreign entries are recorded but never read further. */
  const existing = new Map<string, string>()
  const temps: string[] = []
  try {
    if ((await checkDir(mirror)) && (await checkDir(folderPath))) {
      const hub = await lstatOrNone(path.join(folderPath, HUB))
      if (hub?.isSymbolicLink()) throw new Unsafe(path.join(folderPath, HUB), "symlink")
      if (hub) {
        const content = hub.isFile() ? await io.readFile(path.join(folderPath, HUB), "utf8") : undefined
        if (content === undefined || !owned(content, input.key)) {
          foreign.push(HUB)
          logForeign(HUB, "hub not owned; folder skipped")
          return result("foreign-hub", notCopied)
        }
        existing.set(HUB, content)
      }
      for (const sub of SUBFOLDERS) {
        if (!(await checkDir(subPath(sub)))) continue
        for (const name of await io.readdir(subPath(sub))) {
          const target = path.join(subPath(sub), name)
          const stat = await lstatOrNone(target)
          if (!stat) continue
          if (stat.isSymbolicLink()) throw new Unsafe(target, "symlink")
          if (!stat.isFile()) continue
          if (TEMP_FILE.test(name)) temps.push(`${sub}/${name}`)
          else if (name.endsWith(".md")) existing.set(`${sub}/${name}`, await io.readFile(target, "utf8"))
        }
      }
    }
  } catch (error) {
    if (error instanceof Unsafe) return unsafe(error.at, error.reason)
    throw error
  }

  // ---- Plan: write absent or owned-and-different targets; delete owned notes no longer rendered.
  const writes: [string, string][] = []
  for (const [rel, content] of desired) {
    const now = existing.get(rel)
    if (now === content) continue
    if (now !== undefined && !owned(now, input.key)) {
      foreign.push(rel)
      logForeign(rel, "not owned")
      continue
    }
    writes.push([rel, content])
  }
  const removals = [...existing]
    .filter(([rel, content]) => rel !== HUB && !desired.has(rel) && owned(content, input.key))
    .map(([rel]) => rel)
  // A target name that exists as a directory (or other non-file) is the person's: left alone.
  for (const [rel] of [...writes]) {
    if (existing.has(rel)) continue
    const stat = await lstatOrNone(path.join(dirOf(rel), path.basename(rel)))
    if (stat?.isSymbolicLink()) return unsafe(path.join(dirOf(rel), path.basename(rel)), "symlink")
    if (stat) {
      writes.splice(writes.findIndex(([r]) => r === rel), 1)
      foreign.push(rel)
      logForeign(rel, "not a file")
    }
  }
  if (!writes.length && !removals.length && !temps.length) return result("ok", notCopied)

  // ---- Write.
  let folderReal = ""
  const recheck = async (dir: string) => {
    for (const step of chain(dir)) {
      const stat = await lstatOrNone(step)
      const was = dirStat.get(step)
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !was || stat.dev !== was.dev || stat.ino !== was.ino)
        throw new Unsafe(step, "changed since the check")
    }
  }
  const ensureDir = async (dir: string) => {
    if (dirStat.has(dir)) return
    try {
      await io.mkdir(dir, { mode: 0o700 })
      await io.chmod(dir, 0o700)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error
    }
    if (!(await checkDir(dir))) throw new Unsafe(dir, "vanished")
  }
  /** The real path of a file this run just created must lie under the real folder, else it is removed. */
  const landed = async (target: string) => {
    let real: string
    try {
      real = await io.realpath(target)
    } catch {
      throw new Unsafe(target, "moved after write")
    }
    if (Vault.contains(folderReal, real)) return
    await io.unlink(real).catch(() => undefined)
    throw new Unsafe(target, "landed outside the mirror folder")
  }
  const writeOne = async (rel: string, content: string) => {
    const dir = dirOf(rel)
    const name = path.basename(rel)
    const target = path.join(dir, name)
    const temp = path.join(dir, `.${name}.swarm-${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
    await recheck(dir)
    await input.hook?.("temp", target)
    const handle = await io.open(temp, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
    await landed(temp)
    await input.hook?.("written", target)
    await recheck(dir)
    const before = await lstatOrNone(target)
    if (before && (before.isSymbolicLink() || !before.isFile())) throw new Unsafe(target, "target is not a regular file")
    await input.hook?.("rename", target)
    await io.rename(temp, target)
    await landed(target)
    written.push(rel)
  }
  const removeOne = async (rel: string, record = true) => {
    const dir = dirOf(rel)
    const target = path.join(dir, path.basename(rel))
    await recheck(dir)
    const stat = await lstatOrNone(target)
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Unsafe(target, "target is not a regular file")
    await io.unlink(target)
    if (record) deleted.push(rel)
  }

  try {
    await ensureDir(mirror)
    await ensureDir(folderPath)
    folderReal = await io.realpath(folderPath)
    if (!Vault.contains(rootReal, folderReal)) throw new Unsafe(folderPath, "folder resolves outside the vault")
    for (const sub of new Set(writes.map(([rel]) => rel).filter((rel) => rel !== HUB).map((rel) => path.dirname(rel))))
      await ensureDir(subPath(sub))
    for (const [rel, content] of writes) await writeOne(rel, content)
    for (const rel of removals) await removeOne(rel)
    // Leftover temp files of an interrupted run (own pattern only); not counted as note deletes.
    for (const rel of temps) await removeOne(rel, false)
  } catch (error) {
    if (error instanceof Unsafe) return unsafe(error.at, error.reason)
    // An fs error mid-run after a swap (a rename whose temp file moved away) is the same refusal.
    const swapped = await Promise.all([...dirStat.keys()].map((dir) => recheck(dir).then(() => false, () => true)))
    if (swapped.some(Boolean)) return unsafe(folderPath, String((error as Error)?.message ?? error))
    throw error
  }
  return result("ok", notCopied)
}

// ---------------------------------------------------------------------------------------------------------------
// When the mirror runs (OBS-d, 01c §5, AC-OBSd; row 43d). The callers (Memory, the wrapped Studio close in
// session/tools.ts) hand a job to `schedule`; it runs in the background and never blocks or fails the caller. Per store
// key: a debounced job waits `MIRROR_DEBOUNCE_MS` after the last trigger (T1, T4); an immediate one runs now and
// replaces any pending one (T2 index entry, T3 mission close). Two runs of one store are serialised by `sync`'s lock.

/** N8-111: one mirror refresh per burst of store writes. */
export const MIRROR_DEBOUNCE_MS = 2000

/** A scheduled run: returns the sync result, or undefined when nothing ran (memory off, store disabled, failure). */
export type MirrorJob = () => Promise<SyncResult | undefined>

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<(key: string, result: SyncResult) => void>()
// Label language per store key, as the app last asked for it (`GET /memory/vault?language=`, 01c §4.5 tier 1).
const languages = new Map<string, Language>()

function start(key: string, job: MirrorJob) {
  // A job handles its own errors; this catch only keeps a broken job from becoming an unhandled rejection.
  void job().then(
    (result) => {
      if (result) for (const listener of listeners) listener(key, result)
    },
    () => undefined,
  )
}

/** Run the mirror of one store in the background: now (`immediate`) or after `MIRROR_DEBOUNCE_MS` without a new trigger. */
export function schedule(key: string, job: MirrorJob, options: { readonly immediate?: boolean } = {}): void {
  const pending = timers.get(key)
  if (pending !== undefined) clearTimeout(pending)
  timers.delete(key)
  if (options.immediate) return start(key, job)
  const timer = setTimeout(() => {
    timers.delete(key)
    start(key, job)
  }, MIRROR_DEBOUNCE_MS)
  // A pending refresh never keeps the process alive.
  ;(timer as { unref?: () => void }).unref?.()
  timers.set(key, timer)
}

/** Called after every completed run (tests, diagnostics). Returns the unsubscribe function. */
export function onRun(listener: (key: string, result: SyncResult) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Remember the app's label language for a store (kept in process; the next run writes it as the hub's `swarm-lang`). */
export function rememberLanguage(key: string, language: Language): void {
  languages.set(key, language)
}

/**
 * The project folder's hub as it is on disk: whether an owned hub exists and its `swarm-lang`. No write; a hub that is
 * missing, not a regular file, foreign or unreadable counts as absent.
 */
export async function hubState(directory: string, key: string): Promise<{ exists: boolean; language?: Language }> {
  const rootReal = await Vault.realRoot()
  if (!rootReal) return { exists: false }
  const hub = path.join(rootReal, Vault.VAULT_MIRROR_DIR, Vault.vaultProjectFolder(directory, key), HUB)
  const stat = await fs.lstat(hub).catch(() => undefined)
  if (!stat?.isFile()) return { exists: false }
  const content = await fs.readFile(hub, "utf8").catch(() => undefined)
  if (content === undefined || !owned(content, key)) return { exists: false }
  const match = /^swarm-lang: "(en|id)"$/m.exec(content.slice(0, content.indexOf("\n---\n", 3)))
  return { exists: true, ...(match ? { language: match[1] as Language } : {}) }
}

/** The label language of the next run (01c §4.5): the app's, else the hub's `swarm-lang`, else undefined (= `id`). */
export async function labelLanguage(directory: string, key: string): Promise<Language | undefined> {
  return languages.get(key) ?? (await hubState(directory, key)).language
}

/** T4 (01c §5): the first prompt of a store refreshes the mirror when the hub is absent or its language is stale. */
export async function backfillDue(directory: string, key: string): Promise<boolean> {
  const hub = await hubState(directory, key)
  if (!hub.exists) return true
  const wanted = languages.get(key)
  return wanted !== undefined && wanted !== (hub.language ?? "id")
}

/**
 * N8-437 (OBS-g close nudge, 01c §8.3): the line appended to a successful mission close when the session has
 * `swarm-web_vault_inbox`. With an index entry it names the two vault notes the mirror writes for the mission, exactly
 * as `render` names them (without `.md`); without one, or with an id that cannot be named, no link clause.
 */
export function closeNudge(missionId: string, indexed: boolean): string {
  const mission = indexed && missionIdOk(missionId) ? noteName("mission", missionId) : undefined
  const report = mission ? noteName("report", missionId) : undefined
  if (!mission || !report) return "next: write the vault note for this mission (skill obsidian-memory)."
  return `next: write the vault note for this mission (skill obsidian-memory); link [[${mission.slice(0, -3)}]] and [[${report.slice(0, -3)}]].`
}

export * as VaultMirror from "./vault-mirror"
