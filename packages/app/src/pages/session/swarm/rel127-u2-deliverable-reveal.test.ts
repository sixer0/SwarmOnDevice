// Swarm 1.2.7 row 26, AC-U2 app half (N7-085; U3, C10, SR7-12). Every Mission Control deliverable can be acted on:
// documents open in the file tab, every deliverable found on disk gets "Reveal in Finder / File Explorer", and a
// `.command` / `.app` is revealed only, never opened or launched. The Deliverables list also shows non-Studio files
// placed in docs/<mission>/11_deliverables/ (origin "folder"); the legacy flat docs/<mission>/<name> still opens.
// Model half here; the DOM half (N7-124) runs in a child process like mission-deliverables.test.ts.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { buildMission } from "./mission-model"
import * as deliverablesModel from "./mission-deliverables-model"
import { activateDeliverable, deliverableLines, finalTally, openablePath } from "./mission-deliverables-model"
import { createMissionPoller } from "./mission-poll"
import { registeredStudioOutputs, resetStudioOutputRegistry } from "../studio-output-registry"
import { REVEAL_FIXTURE_DIR as DIR, revealFixture, PDF_P, DOCX_X } from "./rel127-u2-deliverable-reveal.fixture"

const M = "m-u2"
// Namespace read: at the red base the name is absent, so the test fails on an assertion, not on the import.
const MISSION_DELIVERABLES_DIR = (deliverablesModel as Record<string, unknown>).MISSION_DELIVERABLES_DIR as string | undefined
const vm = (delivered: string[] = ["Tandatangani.command", "Tool.app", "notes.md", PDF_P]) =>
  buildMission(revealFixture(), "en", new Set([DOCX_X]), new Set(delivered))

describe("1.2.7 U-2 deliverable reveal (model)", () => {
  test("revealAbsPath for all five lines; path for PDF, DOCX and md, null for .command and .app", () => {
    const lines = deliverableLines(vm(), undefined, DIR)
    const by = Object.fromEntries(lines.map((l) => [l.name, l]))
    expect(Object.keys(by).sort()).toEqual(["Kajian U2", "Lampiran U2", "Tandatangani.command", "Tool.app", "notes.md"])
    expect(by["Kajian U2"].revealAbsPath).toBe(`${DIR}/docs/${M}/11_deliverables/${PDF_P}`)
    expect(by["Lampiran U2"].revealAbsPath).toBe(`${DIR}/docs/${M}/${DOCX_X}`)
    expect(by["Tandatangani.command"].revealAbsPath).toBe(`${DIR}/docs/${M}/11_deliverables/Tandatangani.command`)
    expect(by["Tool.app"].revealAbsPath).toBe(`${DIR}/docs/${M}/11_deliverables/Tool.app`)
    expect(by["notes.md"].revealAbsPath).toBe(`${DIR}/docs/${M}/11_deliverables/notes.md`)
    expect(by["Kajian U2"].path).toBe(`docs/${M}/11_deliverables/${PDF_P}`)
    expect(by["Lampiran U2"].path).toBe(`docs/${M}/${DOCX_X}`) // legacy flat docs/<m>/<name> still opens
    expect(by["notes.md"].path).toBe(`docs/${M}/11_deliverables/notes.md`)
    expect(by["Tandatangani.command"].path).toBeNull()
    expect(by["Tool.app"].path).toBeNull()
    expect(lines.filter((l) => l.origin === "folder").map((l) => l.name).sort()).toEqual([
      "Tandatangani.command",
      "Tool.app",
      "notes.md",
    ])
    expect(by["Kajian U2"].origin).toBe("studio")
    expect([by["Tandatangani.command"].tile, by["Tool.app"].tile, by["notes.md"].tile]).toEqual(["COMMAND", "APP", "MD"])
  })

  test("folder lines do not count in n/m final; a Studio file in 11_deliverables is not listed twice", () => {
    const model = vm([PDF_P, "Tool.app"])
    expect(finalTally(model)).toEqual({ final: 1, total: 2 })
    expect(deliverableLines(model, undefined, DIR).map((l) => l.name)).toEqual(["Kajian U2", "Lampiran U2", "Tool.app"])
    // Hidden files (".DS_Store") are no deliverables.
    expect(deliverableLines(vm([".DS_Store"]), undefined, DIR).some((l) => l.name === ".DS_Store")).toBe(false)
  })

  test("not found = no reveal; no session directory = no reveal; Windows directory keeps its separator", () => {
    const missing = deliverableLines(vm([]), undefined, DIR).find((l) => l.name === "Kajian U2")!
    expect(missing.revealAbsPath).toBeNull()
    expect(deliverableLines(vm(), undefined, undefined).every((l) => l.revealAbsPath === null)).toBe(true)
    const win = deliverableLines(vm(), undefined, "C:\\Users\\u\\proj\\").find((l) => l.name === "Tool.app")!
    expect(win.revealAbsPath).toBe(`C:\\Users\\u\\proj\\docs\\${M}\\11_deliverables\\Tool.app`)
  })

  test("PROJECT_PATH accepts docs/<m>/11_deliverables/<name>, nothing deeper, no ..", () => {
    expect(openablePath(`docs/${M}/11_deliverables/${PDF_P}`)).toBe(`docs/${M}/11_deliverables/${PDF_P}`)
    expect(openablePath(`docs/${M}/${PDF_P}`)).toBe(`docs/${M}/${PDF_P}`)
    expect(openablePath(`docs/${M}/a/b/${PDF_P}`)).toBeNull()
    expect(openablePath(`docs/${M}/other/${PDF_P}`)).toBeNull()
    expect(openablePath(`docs/../11_deliverables/${PDF_P}`)).toBeNull()
    expect(openablePath(`docs/${M}/11_deliverables/..`)).toBeNull()
    expect(MISSION_DELIVERABLES_DIR).toBe("11_deliverables")
  })

  test("N7-018 equals the Studio export folder N7-011 (last of MISSION_DOC_FOLDERS)", () => {
    const render = readFileSync(
      new URL("../../../../../datum-studio/src/mcp-host/mission/export/render.ts", import.meta.url),
      "utf8",
    )
    const block = render.slice(render.indexOf("MISSION_DOC_FOLDERS"), render.indexOf("] as const"))
    const folders = [...block.matchAll(/"([0-9]{2}_[a-z_]+)"/g)].map((m) => m[1])
    expect(folders.length).toBe(11)
    expect(folders.at(-1)).toBe(MISSION_DELIVERABLES_DIR)
  })

  test(".command and .app: activateDeliverable never calls openFile (reveal only, U3)", () => {
    const lines = deliverableLines(vm(), undefined, DIR)
    const opened: string[] = []
    for (const name of ["Tandatangani.command", "Tool.app"]) {
      const line = lines.find((l) => l.name === name)!
      expect(activateDeliverable(line, { openFile: (p) => opened.push(p) })).toBe("not-in-project")
      // A forged path on a folder line is re-checked against the open allowlist.
      expect(activateDeliverable({ ...line, path: `docs/${M}/11_deliverables/${name}` }, { openFile: (p) => opened.push(p) })).toBe(
        "not-in-project",
      )
    }
    expect(opened).toEqual([])
    const notes = lines.find((l) => l.name === "notes.md")!
    expect(activateDeliverable(notes, { openFile: (p) => opened.push(p) })).toBe("opened")
    expect(opened).toEqual([`docs/${M}/11_deliverables/notes.md`])
  })

  test("SR7-12: open allowlist by final extension (case-insensitive); everything else reveal only", () => {
    const names = [
      "a.pdf", "b.HTML", "c.docx", "d.xlsx", "e.pptx", "f.md", "g.TXT",
      "run.sh", "setup.exe", "x.bat", "y.ps1", "z.htm", "README", "report.pdf.command", "Tool.APP",
    ]
    const lines = deliverableLines(vm(names), undefined, DIR).filter((l) => l.origin === "folder")
    const openable = lines.filter((l) => l.path !== null).map((l) => l.name).sort()
    expect(openable).toEqual(["a.pdf", "b.HTML", "c.docx", "d.xlsx", "e.pptx", "f.md", "g.TXT"])
    expect(lines.every((l) => l.revealAbsPath !== null)).toBe(true)
  })

  test("SR7-12: bidi and control characters are stripped from displayed names, the path keeps the real name", () => {
    const raw = "invoice\u202Efdp.command"
    const line = deliverableLines(vm([raw]), undefined, DIR).find((l) => l.origin === "folder")!
    expect(line.name).toBe("invoicefdp.command")
    expect(line.path).toBeNull()
    expect(line.revealAbsPath).toBe(`${DIR}/docs/${M}/11_deliverables/${raw}`)
    const wire = revealFixture()
    wire.deliverables![0].title = "Kaji\u2066an\u2069 \u0007U2\u202A\u0085"
    const studio = deliverableLines(buildMission(wire, "en", new Set(), new Set([PDF_P])), undefined, DIR)[0]
    expect(studio.name).toBe("Kajian U2")
  })

  test("the poll lists docs/<m>/11_deliverables and registers only Studio outputs for the rendered file tab", async () => {
    resetStudioOutputRegistry()
    const asked: string[] = []
    const listing: Record<string, string[]> = {
      [`docs/${M}`]: [DOCX_X],
      [`docs/${M}/11_deliverables`]: [PDF_P, "page.html", "Tandatangani.command"],
    }
    const states: Array<{ mission: ReturnType<typeof buildMission> | null }> = []
    const poller = createMissionPoller({
      source: {
        list: async () => ({
          ok: true,
          data: { items: [{ id: M, title: "U2", type: "document", status: "running", progress: { done: 0, total: 2 }, openRequests: [], updatedAt: "t" }] },
        }),
        get: async () => ({ ok: true, data: revealFixture() }),
      },
      directory: () => "/repo",
      sessions: () => ["ses_u2"],
      lang: () => "en",
      listFiles: async (p) => {
        asked.push(p)
        return listing[p] ?? []
      },
      onState: (s) => states.push(s as never),
    })
    poller.setMode("live")
    for (let i = 0; i < 20 && !states.at(-1)?.mission; i++) await new Promise((r) => setTimeout(r, 0))
    poller.dispose()
    expect(asked).toEqual([`docs/${M}`, `docs/${M}/11_deliverables`])
    const names = states.at(-1)!.mission!.deliverables.map((d) => d.title)
    expect(names).toEqual(["Kajian U2", "Lampiran U2", "page.html", "Tandatangani.command"])
    expect([...registeredStudioOutputs("/repo")].sort()).toEqual(
      [`docs/${M}/11_deliverables/${PDF_P}`, `docs/${M}/${DOCX_X}`].sort(),
    )
    resetStudioOutputRegistry()
  })

  test("C26 and the .app listing: session.tsx keeps the swarm model live in the Shared files view", () => {
    const src = readFileSync(new URL("../../session.tsx", import.meta.url), "utf8")
    const swarm = src.slice(src.indexOf("const swarm = createSwarm("), src.indexOf("const missionControl = createMissionControl("))
    expect(swarm).toMatch(/watching: \(\) =>\s+sessionMap\.opened\(\) && \(sessionMap\.view\.filter === "agents" \|\| sessionMap\.view\.filter === "shared"\)/)
    const mission = src.slice(src.indexOf("const missionControl = createMissionControl("), src.indexOf("const missions: MissionControlMount"))
    expect(mission).not.toMatch(/"shared"/) // mission control polls for the Agents view only
    expect(mission).toMatch(/\.app/)
  })
})

describe("1.2.7 U-2 deliverable reveal (DOM, N7-124)", () => {
  test("one sibling reveal button per line, OS label, reveal call, executables reveal only", async () => {
    const run = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./src/pages/session/swarm/rel127-u2-deliverable-reveal.render.ts",
      ],
      { cwd: new URL("../../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
    )
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 0 fail")
    expect(output).toMatch(/ [1-9][0-9]* pass/)
  }, 60_000)
})

