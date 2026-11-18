// Swarm 1.3.3 row 72 (MC-8 item 5, owner decision U16): Open (system default app) and Preview (PDF or HTML in the
// file tab) on the existing Mission Control deliverables list, for the copies in <project>/deliverables/<mission>/
// (row 68) that the projection lists per document (row 71: `projectFiles`).
// Model half here; the DOM half runs in a child process like mission-deliverables.test.ts.
import { describe, expect, test } from "bun:test"
import { buildMission } from "./mission-model"
import * as model from "./mission-deliverables-model"
import { activateDeliverable, deliverableLines } from "./mission-deliverables-model"
import { DIR72, DOCX_D, fixture72, HTML_D, M72, PDF_C, PDF_D, sha } from "./row72-mc8-open-preview.fixture"

const vm = (dir = DIR72) => buildMission(fixture72(dir), "en", new Set())
const line = (doc: string, dir: string | undefined = DIR72, session: string | undefined = dir) =>
  deliverableLines(vm(), undefined, dir, session).find((l) => l.documentId === doc)!
const link = (doc: string, name: string) => line(doc).links.find((l) => l.path.endsWith(name))!

describe("row 72 MC-8 open and preview (model)", () => {
  test("a present PDF yields Open and Preview with the path and the revision label", () => {
    const pdf = link("doc-d", PDF_D)
    expect(pdf.format).toBe("PDF")
    expect(pdf.present).toBe(true)
    expect(pdf.latest).toBe(true)
    expect(pdf.revision).toBe("Rev D · rev 256")
    expect(pdf.openAbsPath).toBe(`${DIR72}/deliverables/${M72}/${PDF_D}`)
    expect(pdf.previewPath).toBe(`deliverables/${M72}/${PDF_D}`)
    expect(model.linkActions(pdf)).toEqual(["open", "preview"])
  })

  test("HTML previews too; DOCX has Open only", () => {
    expect(model.linkActions(link("doc-d", HTML_D))).toEqual(["open", "preview"])
    const docx = link("doc-d", DOCX_D)
    expect(docx.openAbsPath).toBe(`${DIR72}/deliverables/${M72}/${DOCX_D}`)
    expect(docx.previewPath).toBeNull()
    expect(model.linkActions(docx)).toEqual(["open"])
  })

  test("a file that is not present yields no action", () => {
    const gone = link("doc-gone", "099-GSP-KT-XI-2026 RevA rev7.pdf")
    expect(gone.present).toBe(false)
    expect([gone.openAbsPath, gone.previewPath]).toEqual([null, null])
    expect(model.linkActions(gone)).toEqual([])
    const opened: string[] = []
    expect(model.runDeliverableLink(gone, "open", { openSystem: (p) => opened.push(p) })).toBe(false)
    expect(model.runDeliverableLink(gone, "preview", { previewFile: (p) => opened.push(p) })).toBe(false)
    expect(opened).toEqual([])
  })

  test("older revisions stay listed after the latest and are not marked latest", () => {
    const links = line("doc-d").links
    expect(links.map((l) => [l.format, l.revision, l.latest])).toEqual([
      ["PDF", "Rev D · rev 256", true],
      ["DOCX", "Rev D · rev 256", true],
      ["HTML", "Rev D · rev 256", true],
      ["PDF", "Rev C · rev 201", false],
    ])
    expect(model.linkActions(link("doc-d", PDF_C))).toEqual(["open", "preview"])
    expect(model.linkGroups(links).map((g) => [g.revision, g.latest, g.links.length])).toEqual([
      ["Rev D · rev 256", true, 3],
      ["Rev C · rev 201", false, 1],
    ])
  })

  test("a deliverable without a project copy has no links and keeps its existing line", () => {
    const none = line("doc-none")
    expect(none.links).toEqual([])
    expect(none.path).toBeNull()
    expect(none.revealAbsPath).toBeNull()
  })

  test("only projection paths of the deliverables shape are ever opened or previewed", () => {
    const base = { format: "PDF", sha256: sha("a"), latest: true, present: true, docRev: "A", revisionNo: 1 }
    const mk = (path: string, absolutePath?: string) =>
      model.deliverableLinks([{ ...base, path, ...(absolutePath ? { absolutePath } : {}) }], DIR72)[0]
    const good = `deliverables/${M72}/${PDF_D}`
    expect(model.linkActions(mk(good, `${DIR72}/${good}`))).toEqual(["open", "preview"])
    // no absolute path from the host: nothing to hand to the system
    expect(model.linkActions(mk(good))).toEqual([])
    // shapes the host never writes
    for (const bad of [
      `deliverables/${M72}/../${PDF_D}`,
      `deliverables/${M72}/sub/${PDF_D}`,
      `docs/${M72}/${PDF_D}`,
      `/etc/${PDF_D}`,
      `deliverables/${M72}/run.command`,
      `deliverables/${M72}/Tool.app`,
    ])
      expect(model.linkActions(mk(bad, `${DIR72}/${bad}`))).toEqual([])
    // the absolute path must be this project path (no other file under the same label)
    expect(model.linkActions(mk(good, `/elsewhere/${PDF_D}`))).toEqual([])
    expect(model.linkActions(mk(good, `${DIR72}/deliverables/other/${PDF_D}`))).toEqual([])
    // a format that is not the file's extension is not offered
    expect(model.linkActions(model.deliverableLinks([{ ...base, format: "DOCX", path: good, absolutePath: `${DIR72}/${good}` }], DIR72)[0])).toEqual([])
  })

  test("the mission's folder is not the session's folder: Open stays, Preview is not offered", () => {
    const pdf = line("doc-d", DIR72, "/work/other-session").links[0]
    expect(model.linkActions(pdf)).toEqual(["open"])
  })

  test("Windows absolute path of the same project file is accepted", () => {
    const rel = `deliverables/${M72}/${PDF_D}`
    const abs = `C:\\Users\\u\\proj\\deliverables\\${M72}\\${PDF_D}`
    const l = model.deliverableLinks(
      [{ path: rel, absolutePath: abs, format: "PDF", sha256: sha("a"), latest: true, present: true }],
      "C:\\Users\\u\\proj",
    )[0]
    expect(l.openAbsPath).toBe(abs)
    expect(l.previewPath).toBe(rel)
    expect(l.revision).toBe("")
  })

  test("actions call the bridge with the path as data", () => {
    const pdf = link("doc-d", PDF_D)
    const calls: string[] = []
    const actions = {
      openSystem: (p: string) => calls.push(`open:${p}`),
      previewFile: (p: string) => calls.push(`preview:${p}`),
    }
    expect(model.runDeliverableLink(pdf, "open", actions)).toBe(true)
    expect(model.runDeliverableLink(pdf, "preview", actions)).toBe(true)
    expect(model.runDeliverableLink(link("doc-d", DOCX_D), "preview", actions)).toBe(false)
    expect(calls).toEqual([`open:${DIR72}/deliverables/${M72}/${PDF_D}`, `preview:deliverables/${M72}/${PDF_D}`])
    // no bridge (web build): nothing is offered
    expect(model.linkActions(pdf, {})).toEqual([])
    expect(model.linkActions(pdf, { previewFile: actions.previewFile })).toEqual(["preview"])
  })

  test("the existing line: click previews the latest PDF of the project copy; Reveal gets its absolute path", () => {
    const d = line("doc-d")
    expect(d.path).toBe(`deliverables/${M72}/${PDF_D}`)
    expect(d.revealAbsPath).toBe(`${DIR72}/deliverables/${M72}/${PDF_D}`)
    const opened: string[] = []
    expect(activateDeliverable(d, { openFile: (p) => opened.push(p) })).toBe("opened")
    expect(opened).toEqual([`deliverables/${M72}/${PDF_D}`])
    // nothing present: the not-in-project state, as before
    expect(line("doc-gone").path).toBeNull()
    expect(activateDeliverable(line("doc-gone"), { openFile: (p) => opened.push(p) })).toBe("not-in-project")
  })

  test("links for a row or a document (row 73's entry)", () => {
    const m = vm()
    expect(model.missionDeliverableLinks(m, { rowId: "1" }, DIR72).map((l) => l.path)).toEqual(line("doc-d").links.map((l) => l.path))
    expect(model.missionDeliverableLinks(m, { documentId: "doc-gone" }, DIR72).length).toBe(1)
    expect(model.missionDeliverableLinks(m, { rowId: "9" }, DIR72)).toEqual([])
    expect(model.missionDeliverableLinks(null, { rowId: "1" }, DIR72)).toEqual([])
    // latest only, for a compact place such as the decision card
    expect(model.latestLinks(model.missionDeliverableLinks(m, { rowId: "1" }, DIR72)).map((l) => l.format)).toEqual(["PDF", "DOCX", "HTML"])
  })
})

describe("row 72 MC-8 open and preview (DOM)", () => {
  test("renders the links on the existing list and calls the two actions", async () => {
    const run = Bun.spawn(
      [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./src/pages/session/swarm/row72-mc8-open-preview.render.ts"],
      { cwd: new URL("../../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
    )
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 0 fail")
    expect(output).toMatch(/ [1-9][0-9]* pass/)
  }, 60_000)
})
