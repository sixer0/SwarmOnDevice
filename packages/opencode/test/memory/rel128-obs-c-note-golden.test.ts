// 1.2.8 row 43b, AC-OBSc (N8-359): the vault mirror note format, rendered pure (01c §4, 01_specs §5.2 and §5.6, C7,
// SR8-13, SR8-14). Red at BASE e1f9673772: `src/memory/vault-mirror.ts` does not exist.
//
// The describe "triggers" of this file (AC-OBSd) belongs to row 43d. Inputs are synthetic (fixtures/rel128-obs-c).
// `render` touches no disk; `readReport` reads only inside a mkdtemp folder. Nothing here reads HOME or the vault.
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { VaultMirror } from "../../src/memory/vault-mirror"

const FIXTURES = path.join(import.meta.dir, "fixtures", "rel128-obs-c")
const store = JSON.parse(fs.readFileSync(path.join(FIXTURES, "store.json"), "utf8"))
const REPORT_PATH = "docs/2026-11-13_kajian-tarif/10_report/report.md"
const reportText = fs.readFileSync(path.join(FIXTURES, "report.md"), "utf8")

type Item = VaultMirror.RenderInput["items"][number]

const base = (over: Partial<VaultMirror.RenderInput> = {}): VaultMirror.RenderInput => ({
  key: store.key,
  folder: store.folder,
  projectName: store.projectName,
  items: store.items,
  reports: { [REPORT_PATH]: { status: "ok", text: reportText } },
  ...over,
})

const note = (over: Partial<Item> & { id: string; text: string }): Item => ({
  source: "agent",
  deviceOnly: false,
  time: 1763000000000,
  ...over,
})

const goldenFiles = (lang: string) => {
  const root = path.join(FIXTURES, "golden", lang)
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8")
    }
  }
  walk(root)
  return out
}

const byPath = (result: VaultMirror.RenderResult) => Object.fromEntries(result.files.map((f) => [f.path, f.content]))
const bodyOf = (content: string) => content.slice(content.indexOf("\n---\n") + 5)
const sha6 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6)

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o43b-"))
  temps.push(dir)
  return dir
}

describe("AC-OBSc OBS-c-1 golden files (syn128 store)", () => {
  test("language id (no language passed) renders byte-equal to golden/id", () => {
    expect(byPath(VaultMirror.render(base()))).toEqual(goldenFiles("id"))
  })

  test("language en renders byte-equal to golden/en", () => {
    expect(byPath(VaultMirror.render(base({ language: "en" })))).toEqual(goldenFiles("en"))
  })

  test("pure: same output for a shuffled store, sorted by path", () => {
    const a = VaultMirror.render(base())
    const b = VaultMirror.render(base({ items: [...store.items].reverse() }))
    expect(b).toEqual(a)
    expect(a.files.map((f) => f.path)).toEqual(a.files.map((f) => f.path).toSorted())
  })

  test("properties: marker, key, id, source, hash of the body; hub carries swarm-lang and the project alias", () => {
    const files = byPath(VaultMirror.render(base()))
    for (const [file, content] of Object.entries(files)) {
      expect(content.startsWith("---\nswarm-mirror: true\nswarm-key: \"dir-3fa9c1d2e4b5a6978c0d1e2f\"\n")).toBe(true)
      const hash = /\nswarm-hash: "([0-9a-f]{16})"\n/.exec(content)![1]
      expect(hash).toBe(VaultMirror.bodyHash(bodyOf(content)))
      expect(content.includes("swarm-lang:")).toBe(file === "index.md")
      // Tags of N8-109 only.
      for (const tag of content.match(/^ {2}- "swarm-memory\/[^"]*"$/gm) ?? [])
        expect(tag).toMatch(/^ {2}- "swarm-memory\/(note|index|report|skill|untrusted|mission\/[a-z0-9_-]+)"$/)
      // No property carries a link.
      expect(content.slice(0, content.indexOf("\n---\n")).includes("[[")).toBe(false)
    }
    expect(files["index.md"]).toContain('swarm-id: "index"\nswarm-source: "index"')
    expect(files["index.md"]).toContain('swarm-lang: "id"\ntags:\n  - "swarm-memory/index"\naliases:\n  - "Default Project"\n---\n')
  })

  test("links: every note links its hub; mission <-> report; roll-up -> its missions; related newest first", () => {
    const files = byPath(VaultMirror.render(base()))
    const hub = "[[swarm-memory/default-project-3fa9c1/index|Default Project]]"
    for (const [file, content] of Object.entries(files)) if (file !== "index.md") expect(content).toContain(hub)
    const mission = "missions/2026-11-13-kajian-tarif-8504b0.md"
    const report = "reports/2026-11-13-kajian-tarif-report-8504b0.md"
    expect(files[mission]).toContain(
      "[[swarm-memory/default-project-3fa9c1/reports/2026-11-13-kajian-tarif-report-8504b0|2026-11-13_kajian-tarif-report]]",
    )
    expect(files[report]).toContain(
      "[[swarm-memory/default-project-3fa9c1/missions/2026-11-13-kajian-tarif-8504b0|2026-11-13_kajian-tarif]]",
    )
    const rollup = files["notes/2026-q3-roll-up-2-missions-triggers-lumen-sync-crash-body-f6a7b8.md"]!
    expect(rollup).toContain("missions/2026-09-04-lumen-offline-sync-eeda8f|2026-09-04_lumen-offline-sync]]")
    expect(rollup).toContain("missions/2026-09-06-lumen-crash-triage-680114|2026-09-06_lumen-crash-triage]]")
    // Archived members add no note of their own; their missions come from the roll-up.
    expect(Object.keys(files).some((f) => f.includes("0a1b2c") || f.includes("1b2c3d"))).toBe(false)
    // The hub links every file of the folder.
    for (const file of Object.keys(files))
      if (file !== "index.md") expect(files["index.md"]).toContain(`[[swarm-memory/default-project-3fa9c1/${file.slice(0, -3)}|`)
  })

  test("related cap 10, newest first", () => {
    const items = Array.from({ length: 14 }, (_, n) =>
      note({ id: (0xa00000 + n).toString(16), text: `catatan ${n}`, sessionID: "ses_x", time: 1000 + n }),
    )
    const files = byPath(VaultMirror.render(base({ items, reports: {} })))
    const first = files[`notes/catatan-0-a00000.md`]!
    const related = first.slice(first.indexOf("## Terkait")).match(/^- \[\[/gm) ?? []
    expect(related).toHaveLength(10)
    expect(first.indexOf("a0000d]]")).toBeLessThan(first.indexOf("a0000c]]"))
    expect(first).toContain("|a00004]]")
    expect(first).not.toContain("|a00003]]")
  })

  test("untrusted: tag swarm-memory/untrusted and the L8 callout", () => {
    const files = byPath(VaultMirror.render(base()))
    const untrusted = files["notes/bun-test-di-packages-opencode-butuh-timeout-30000-c3d4e5.md"]!
    expect(untrusted).toContain('  - "swarm-memory/untrusted"')
    expect(untrusted).toContain("> [!warning] Ditulis setelah sesi membaca web, MCP, Studio, atau berkas di luar proyek.")
    const trusted = files["notes/tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md"]!
    expect(trusted).not.toContain("swarm-memory/untrusted")
    expect(trusted).not.toContain("[!warning]")
  })
})

describe("AC-OBSc OBS-c-2 masking and no new exposure", () => {
  test("deviceOnly, secret-looking and classified items are not copied; hub L6 count", () => {
    const items = [
      ...store.items,
      note({ id: "aa0001", text: "Hanya di perangkat ini.", deviceOnly: true }),
      note({ id: "aa0002", text: "kunci sk-live-4f9a8b7c6d5e4f3a2b1c0d" }),
      note({ id: "aa0003", text: "Catatan lampiran.", body: "Dokumen ini TERBATAS." }),
    ]
    const result = VaultMirror.render(base({ items }))
    expect(result.notCopied).toBe(3)
    const all = result.files.map((f) => f.path + f.content).join("\n")
    for (const id of ["aa0001", "aa0002", "aa0003"]) expect(all).not.toContain(id)
    expect(all).not.toContain("sk-live")
    expect(byPath(result)["index.md"]).toContain(
      "\n3 catatan tidak disalin ke sini: hanya di perangkat ini, tampak berisi rahasia, atau ditandai sebagai dokumen berklasifikasi.\n",
    )
    expect(byPath(VaultMirror.render(base({ items, language: "en" })))["index.md"]).toContain(
      "\n3 notes are not copied here: kept on this device only, secret-looking, or marked as classified.\n",
    )
  })

  test("report masking: password=hunter2x9 -> [hidden:password], line count kept", () => {
    const text = "# Laporan\n\nkoneksi: password=hunter2x9\nbaris biasa\n"
    const files = byPath(VaultMirror.render(base({ reports: { [REPORT_PATH]: { status: "ok", text } } })))
    const report = files["reports/2026-11-13-kajian-tarif-report-8504b0.md"]!
    expect(report).toContain("koneksi: password=[hidden:password]\nbaris biasa\n")
    expect(report).not.toContain("hunter2x9")
    expect(VaultMirror.neutraliseReport(text).split("\n")).toHaveLength(text.split("\n").length)
  })

  test("report with RAHASIA -> L10 link-only (id and en)", () => {
    const reports = { [REPORT_PATH]: { status: "ok" as const, text: "# Laporan\n\nKlasifikasi: RAHASIA\nisi rahasia negara\n" } }
    const id = byPath(VaultMirror.render(base({ reports })))["reports/2026-11-13-kajian-tarif-report-8504b0.md"]!
    expect(id).toContain(
      "Laporan ini ditandai sebagai dokumen berklasifikasi dan tidak disalin ke sini. Buka di docs\\/2026\\-11\\-13\\_kajian\\-tarif\\/10\\_report\\/report\\.md.\n",
    )
    expect(id).not.toContain("isi rahasia")
    const en = byPath(VaultMirror.render(base({ reports, language: "en" })))["reports/2026-11-13-kajian-tarif-report-8504b0.md"]!
    expect(en).toContain("This report is marked as classified and is not copied here. Open it at docs")
  })

  test("readReport: outside the project, symlink, not .md -> missing (L11); 300 KB -> large (L9); inside -> ok", async () => {
    const root = tempDir()
    const project = path.join(root, "project")
    fs.mkdirSync(path.join(project, "docs/m/10_report"), { recursive: true })
    fs.writeFileSync(path.join(root, "outside.md"), "# luar\n")
    fs.writeFileSync(path.join(project, "docs/m/10_report/report.md"), "# isi\n")
    fs.writeFileSync(path.join(project, "docs/m/10_report/big.md"), "a".repeat(300 * 1024))
    fs.writeFileSync(path.join(project, "docs/m/10_report/report.txt"), "x")
    fs.symlinkSync(path.join(root, "outside.md"), path.join(project, "docs/m/10_report/link.md"))
    fs.symlinkSync(root, path.join(project, "docs/up"))
    expect(await VaultMirror.readReport(project, "docs/m/10_report/report.md")).toEqual({ status: "ok", text: "# isi\n" })
    expect(await VaultMirror.readReport(project, "../outside.md")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "../../outside.md")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "docs/m/10_report/link.md")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "docs/up/outside.md")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, path.join(root, "outside.md"))).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "docs/m/10_report/report.txt")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "docs/m/10_report/absent.md")).toEqual({ status: "missing" })
    expect(await VaultMirror.readReport(project, "docs/m/10_report/big.md")).toEqual({ status: "large" })
  })

  test("L9 and L11 notes in the report file", () => {
    const large = byPath(VaultMirror.render(base({ reports: { [REPORT_PATH]: { status: "large" } } })))
    expect(large["reports/2026-11-13-kajian-tarif-report-8504b0.md"]).toContain(
      "Laporan ini lebih besar dari 256 KB dan tidak disalin ke sini. Buka di docs\\/2026",
    )
    const missing = byPath(VaultMirror.render(base({ reports: {} })))
    expect(missing["reports/2026-11-13-kajian-tarif-report-8504b0.md"]).toContain(
      "Berkas laporan tidak ada, berada di luar proyek ini, atau tidak dapat dibaca, jadi tidak disalin ke sini. Lokasi: docs\\/2026",
    )
    const tooBig = { [REPORT_PATH]: { status: "ok" as const, text: "a".repeat(VaultMirror.MIRROR_REPORT_MAX_BYTES + 1) } }
    expect(byPath(VaultMirror.render(base({ reports: tooBig, language: "en" })))["reports/2026-11-13-kajian-tarif-report-8504b0.md"]).toContain(
      "This report is larger than 256 KB and is not copied here. Open it at docs",
    )
  })

  test("memory text is escaped: no unescaped ![, [[ or <, no tag, no bare URL", () => {
    const text = "![x](https://e.invalid/a.png) [[other]] <img src=x> #tag https://e.invalid %%c%% ==h=="
    const files = byPath(VaultMirror.render(base({ items: [note({ id: "ab0001", text, body: "![[gambar.png]]\n<iframe>" })], reports: {} })))
    const content = Object.entries(files).find(([f]) => f.startsWith("notes/"))![1]
    const body = bodyOf(content)
    const unescaped = (needle: string) => {
      for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) if (body[i - 1] !== "\\") return true
      return false
    }
    const userText = body.slice(body.indexOf("\\!"))
    expect(userText).not.toMatch(/(^|[^\\])!\[/)
    expect(userText).not.toMatch(/(^|[^\\])\[\[/)
    expect(userText).not.toMatch(/(^|[^\\])</)
    expect(userText).not.toMatch(/(^|[^\\])#tag/)
    expect(userText).not.toMatch(/https:\/\//)
    expect(unescaped("<")).toBe(false)
    expect(body).toContain("\\!\\[x\\]\\(https\\:\\/\\/e\\.invalid\\/a\\.png\\) \\[\\[other\\]\\] \\<img src\\=x\\>")
  })
})

describe("AC-OBSc SR8-13 report copies cannot run code or open other apps", () => {
  const n = (text: string) => VaultMirror.neutraliseReport(text)

  test("fence info strings off MIRROR_PLAIN_FENCE_LANGS become text", () => {
    expect(n("```dataviewjs\ndv.x()\n```")).toBe("```text\ndv.x()\n```")
    expect(n("```dataview\nLIST\n```")).toBe("```text\nLIST\n```")
    expect(n("```mermaid\ngraph TD\n```")).toBe("```text\ngraph TD\n```")
    expect(n("~~~{dataviewjs}\nx\n~~~")).toBe("```text\nx\n```")
    expect(n("```ts\nconst a = 1\n```")).toBe("```ts\nconst a = 1\n```")
    expect(n("```\nplain\n```")).toBe("```\nplain\n```")
    expect(n("```ts title=x\na\n```")).toBe("```ts\na\n```")
    for (const lang of VaultMirror.MIRROR_PLAIN_FENCE_LANGS) expect(n("```" + lang + "\nx\n```")).toBe("```" + lang + "\nx\n```")
  })

  test("a fence holding backtick runs is closed by a longer mark; inside it nothing is changed but masking", () => {
    expect(n("````md\n```js\n<img>\n```\n````")).toBe("````md\n```js\n<img>\n```\n````")
    expect(n("```html\n<b>ok</b>\n```\n<b>not ok</b>")).toBe("```html\n<b>ok</b>\n```\n&lt;b>not ok&lt;/b>")
  })

  test("an indented fence that a list could close early is written at column 0", () => {
    const out = n("- a\n  ```js\n<img src=x onerror=y>\n```\n<i>after</i>")
    expect(out).toBe("- a\n```js\n<img src=x onerror=y>\n```\n&lt;i>after&lt;/i>")
  })

  test("inline code starting with = or $= gets a leading space", () => {
    expect(n("nilai `= this.file.name` di sini")).toBe("nilai ` = this.file.name` di sini")
    expect(n("`$= dv.pages().length`")).toBe("` $= dv.pages().length`")
    expect(n("` = x `")).toBe("` = x`")
    expect(n("`= x `")).toBe("`  = x `")
    expect(n("`a = b` dan `<T>`")).toBe("`a = b` dan `<T>`")
  })

  test("link targets other than http, https, mailto are written as escaped text", () => {
    expect(n("[ok](https://example.invalid/a)")).toBe("[ok](https://example.invalid/a)")
    expect(n("[m](mailto:a@example.invalid)")).toBe("[m](mailto:a@example.invalid)")
    expect(n("[rel](docs/a.md)")).toBe("[rel](docs/a.md)")
    for (const target of [
      "obsidian://open?vault=a",
      "javascript:alert(1)",
      "file:///etc/hosts",
      "JavaScript:alert(1)",
      "javascript&#58;alert(1)",
      "java&#x73;cript:alert(1)",
      "<javascript:alert(1)>",
      "data:text/html,x",
    ]) {
      const out = n(`[x](${target})`)
      expect(out.startsWith("[x]\\(")).toBe(true)
      expect(out).not.toMatch(/\]\(/)
    }
    // Reference definitions and a destination on the next line.
    expect(n("[r]: javascript:alert(1)\n\n[x][r]")).toStartWith("[r]\\:")
    expect(n("[x](\njavascript:alert(1))")).toStartWith("[x]\\(")
    // Nested brackets in the link text do not hide the target.
    expect(n("[a [b] c](obsidian://open?x)")).not.toContain("](")
    // Bare non-web addresses cannot be auto-linked.
    expect(n("buka obsidian://open?vault=x")).toBe("buka obsidian\\://open?vault=x")
    expect(n("lihat https://example.invalid")).toBe("lihat https://example.invalid")
  })

  test("raw HTML, image auto-load and embeds are neutralised outside code", () => {
    expect(n('<iframe src="https://e.invalid"></iframe>')).toBe('&lt;iframe src="https://e.invalid">&lt;/iframe>')
    expect(n("![img](https://e.invalid/a.png)")).toBe("[img](https://e.invalid/a.png)")
    expect(n("![[rahasia.png]]")).toBe("[[rahasia.png]]")
    // An escaped backtick does not open a code span that would shield HTML.
    expect(n("\\`<img src=x onerror=y>` ok`")).not.toContain("<img")
    // A backtick left open on an earlier line could pair with one on this line: the line is treated as text.
    expect(n("a ` b\nc ` <img src=x onerror=y> `")).not.toContain("<img")
    // A blank line ends the paragraph, so code spans pair again.
    expect(n("a ` b\n\n`<T>`")).toBe("a ` b\n\n`<T>`")
  })
})

describe("AC-OBSc SR8-14 every non-public classification", () => {
  test("whole words TERBATAS, RAHASIA, CONFIDENTIAL, RESTRICTED, any case", () => {
    for (const word of VaultMirror.MIRROR_CLASSIFIED_WORDS) {
      expect(VaultMirror.classified(`Dokumen ${word}.`)).toBe(true)
      expect(VaultMirror.classified(`dokumen ${word.toLowerCase()}`)).toBe(true)
    }
    expect(VaultMirror.classified("SANGAT RAHASIA")).toBe(true)
    expect(VaultMirror.classified("unrestricted access, nonconfidential")).toBe(false)
    expect(VaultMirror.classified("terbatasnya waktu")).toBe(false)
  })

  test("an item or report with CONFIDENTIAL or restricted is not copied; L6 and L10 say marked as classified", () => {
    const items = [...store.items, note({ id: "cc0001", text: "Spec is CONFIDENTIAL." })]
    const reports = { [REPORT_PATH]: { status: "ok" as const, text: "# Report\n\nDistribution: restricted\n" } }
    const files = byPath(VaultMirror.render(base({ items, reports, language: "en" })))
    expect(Object.values(files).join("\n")).not.toContain("cc0001")
    expect(files["index.md"]).toContain("1 notes are not copied here: kept on this device only, secret-looking, or marked as classified.")
    expect(files["reports/2026-11-13-kajian-tarif-report-8504b0.md"]).toContain("This report is marked as classified and is not copied here.")
    expect(files["reports/2026-11-13-kajian-tarif-report-8504b0.md"]).not.toContain("Distribution")
  })
})

describe("AC-OBSc C7 readable note names (noteName)", () => {
  test("slug plus 6-hex id per kind", () => {
    expect(VaultMirror.noteName("note", "a1b2c3", "Tabel tarif dibaca dari lampiran B, bukan A.\nbaris dua")).toBe(
      "tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md",
    )
    expect(VaultMirror.noteName("note", "r0000", "x")).toBe(`x-${sha6("r0000")}.md`)
    const h6 = sha6("2026-11-13_kajian-tarif")
    expect(VaultMirror.noteName("mission", "2026-11-13_kajian-tarif")).toBe(`2026-11-13-kajian-tarif-${h6}.md`)
    expect(VaultMirror.noteName("report", "2026-11-13_kajian-tarif")).toBe(`2026-11-13-kajian-tarif-report-${h6}.md`)
    expect(VaultMirror.noteName("skill", "tarif-check")).toBe(`tarif-check-${sha6("tarif-check")}.md`)
  })

  test("folding: NFKD, marks dropped, lower-case, runs collapsed, cut at a dash within 60, empty -> kind word", () => {
    expect(VaultMirror.noteName("note", "abcdef", "Café Ünïcode — Ｔｅｓｔ!!")).toBe("cafe-unicode-test-abcdef.md")
    const long = Array.from({ length: 20 }, (_, i) => `kata${i}`).join(" ")
    const name = VaultMirror.noteName("note", "abcdef", long)!
    const slug = name.slice(0, -"-abcdef.md".length)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(long.toLowerCase().replaceAll(" ", "-").startsWith(slug + "-")).toBe(true)
    expect(VaultMirror.noteName("note", "abcdef", "x".repeat(80))).toBe("x".repeat(60) + "-abcdef.md")
    expect(VaultMirror.noteName("note", "abcdef", "!!! ???")).toBe("note-abcdef.md")
    expect(VaultMirror.noteName("note", "abcdef", "")).toBe("note-abcdef.md")
    const longMission = "2026-11-13_" + "a".repeat(70)
    expect(VaultMirror.noteName("report", longMission)).toMatch(/-report-[0-9a-f]{6}\.md$/)
  })

  test("no separator, no leading dot, no '..' can survive; every generated name matches VAULT_NOTE_NAME_PATTERN", () => {
    for (const source of ["../../etc/passwd", ".hidden", "a/b\\c", "..", "/abs", "\u0000x"]) {
      const name = VaultMirror.noteName("note", "abcdef", source)!
      expect(name).toMatch(VaultMirror.VAULT_NOTE_NAME_PATTERN)
      expect(name.includes("/") || name.includes("\\") || name.startsWith(".")).toBe(false)
    }
    for (const file of VaultMirror.render(base()).files)
      if (file.path !== "index.md") expect(path.basename(file.path)).toMatch(VaultMirror.VAULT_NOTE_NAME_PATTERN)
  })

  test("an unsafe id or mission id is skipped (VAULT_PATH_UNSAFE) and counted", () => {
    const items = [
      note({ id: "../../a", text: "jalur" }),
      note({ id: "dd0001", kind: "index", missionId: "../x", text: "2026-11-13 ../x | o | triggers: a | docs/x/r.md" }),
    ]
    const result = VaultMirror.render(base({ items, reports: {} }))
    expect(result.unsafe).toBe(2)
    expect(result.notCopied).toBe(2)
    expect(result.files.map((f) => f.path)).toEqual(["index.md"])
    expect(VaultMirror.render(base({ folder: "../x" })).files).toEqual([])
  })

  test("a title change gives a new name with the same id part", () => {
    const before = VaultMirror.noteName("note", "a1b2c3", "Judul lama")
    const after = VaultMirror.noteName("note", "a1b2c3", "Judul baru")
    expect(before).not.toBe(after)
    expect(before!.slice(-10)).toBe(after!.slice(-10))
  })
})

describe("AC-OBSc OBS-c-3 labels per language", () => {
  test("no language -> id labels; en -> en labels; note content identical between languages", () => {
    const id = byPath(VaultMirror.render(base()))
    const en = byPath(VaultMirror.render(base({ language: "en" })))
    expect(id["index.md"]).toContain("# Default Project: memori Swarm\n")
    expect(id["index.md"]).toContain('swarm-lang: "id"')
    expect(en["index.md"]).toContain("# Default Project: Swarm memory\n")
    expect(en["index.md"]).toContain('swarm-lang: "en"')
    for (const label of ["## Misi", "## Laporan", "## Catatan", "## Keahlian"]) expect(id["index.md"]).toContain(label)
    for (const label of ["## Missions", "## Reports", "## Notes", "## Skills"]) expect(en["index.md"]).toContain(label)
    expect(Object.keys(en)).toEqual(Object.keys(id))
    const content = "Tabel tarif dibaca dari lampiran B\\, bukan A\\."
    expect(id["notes/tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md"]).toContain(content)
    expect(en["notes/tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md"]).toContain(content)
    expect(en["notes/tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md"]).toContain("**References**:")
    expect(en["notes/tabel-tarif-dibaca-dari-lampiran-b-bukan-a-a1b2c3.md"]).toContain("## Related")
  })
})
