// Write and disclosure UI tests (plan M8-07): U-UI-03, U-UI-07, U-UI-08, U-UI-10, U-UI-11,
// U-UI-18, U-UI-19, U-UI-22, U-UI-23, and the unit halves of ST-23 (SC-42..SC-44) and ST-30
// (SC-50). The real App over the in-memory bridge, host adapters, storage and manual timers.
import { afterEach, describe, expect, test } from "bun:test"
import "./solid-test"
import { OFFICE_EXCEL_CELL_MAX_CHARS } from "../constants"
import { memoryStore } from "../state/test-store"

const { mount, settle, frames, renderGrid } = await import("./harness")
const { isInternalProvider } = await import("./disclosure")
const { dict: en } = await import("../i18n/en")
const { invisibleCount, visibleText, GRID_ALL_CELLS } = await import("./preview")

type Mounted = Awaited<ReturnType<typeof mount>>
const open: Mounted[] = []
const track = async (...args: Parameters<typeof mount>) => {
  const pane = await mount(...args)
  open.push(pane)
  return pane
}
afterEach(() => open.splice(0).forEach((pane) => pane.unmount()))

const SES = "ses_new"
const connected = { token: true, acknowledged: true }
const key = (el: Element, init: KeyboardEventInit) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
const text = (pane: Mounted, selector: string) => pane.q(selector)?.textContent ?? ""
const prompts = (pane: Mounted) => pane.bridge.requests.filter((r) => r.path.endsWith("/prompt_async"))
const disabled = (el: Element | null) => el?.getAttribute("aria-disabled") === "true"

async function send(pane: Mounted, draft: string, first = true) {
  pane.controller.setDraft(draft)
  const sent = pane.controller.send()
  if (first) {
    await pane.bridge.streamOpened
    pane.bridge.push(frames.connected)
  }
  await sent
  await settle()
}

function reply(pane: Mounted, input: { id?: string; text: string; provider?: string; idle?: boolean }) {
  const id = input.id ?? "msg_a"
  pane.bridge.push(frames.message(SES, id, "assistant", { providerID: input.provider ?? "gsp-ai-tail", modelID: "thinker" }))
  pane.bridge.push(frames.part(SES, id, `${id}_pt`, "text"))
  pane.bridge.push(frames.delta(SES, id, `${id}_pt`, input.text))
  if (input.idle !== false) pane.bridge.push(frames.idle(SES))
}

// Mounts, sends one prompt and finishes one reply with `answer`.
async function answered(answer: string, options: Parameters<typeof mount>[0] = {}) {
  const pane = await track({ ...connected, ...options })
  await send(pane, "question")
  reply(pane, { text: answer })
  await settle()
  return pane
}

async function click(pane: Mounted, selector: string) {
  pane.q(selector)!.click()
  await settle()
}

const previews = (pane: Mounted) => pane.qa("[data-part=preview]")

describe("U-UI-10 SC-43 preview: exact text, count and target before any write", () => {
  test("Word Insert: heading, target after the selection, exact text, counts, confirm; no write yet", async () => {
    const answer = "First line  \nSecond line\n\n"
    const pane = await answered(answer)
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview] h4")).toBe("Preview: Insert")
    expect(text(pane, "[data-part=preview-target]")).toBe("After the selection")
    // FR-04: trailing breaks removed; inner spaces kept.
    expect(text(pane, "[data-part=preview-text]")).toBe("First line  \nSecond line")
    expect(text(pane, "[data-part=preview-counts]")).toBe("24 characters · 2 paragraphs")
    expect(text(pane, "[data-control=write]")).toBe("Write to document")
    expect(pane.q("[data-part=preview-removed]")).toBeNull()
    expect(pane.word.doc.calls).toEqual([])
    // Focus moves to the heading (design §6.1).
    expect(document.activeElement).toBe(pane.q("[data-part=preview] h4"))
  })

  test("Word Replace shows the struck-through selection (first 120 characters); collapsed shows At the cursor", async () => {
    const long = "x".repeat(130) + "\r"
    const pane = await answered("New", { word: { selection: long } })
    await click(pane, "[data-control=replace]")
    expect(text(pane, "[data-part=preview-target]")).toBe("Replaces the selection")
    expect(text(pane, "[data-part=preview-removed]")).toBe("x".repeat(120))
    expect(pane.word.doc.calls).toEqual([])

    pane.word.doc.selection = ""
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview-target]")).toBe("At the cursor")
    await click(pane, "[data-control=replace]")
    expect(text(pane, "[data-part=preview-target]")).toBe("At the cursor")
    expect(pane.q("[data-part=preview-removed]")).toBeNull()
  })

  test("Excel Insert shows the A1 target and size; nothing written before confirm", async () => {
    const pane = await answered("1\t2\n3\t4", { host: "Excel" })
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview-target]")).toBe("Cells A2:B3 · 2 x 2 cells")
    expect(pane.excel.book.calls).toEqual([])
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls.map((call) => `${call.method} ${call.address}`)).toEqual(["values A2:B3", "select A2:B3"])
    expect(text(pane, "[data-part=toast]")).toContain("Written: A2:B3")
    expect(pane.q("[data-part=toast]")!.getAttribute("role")).toBe("status")
  })
})

describe("U-UI-11 Word Insert plan through the UI (D6, C22)", () => {
  const cases: [string, string, string][] = [
    ["a whole paragraph (trailing \\r)", "Para\r", "Hello\n"],
    ["a selection without \\r", "Para", "Hello"],
    ["a collapsed selection", "", "Hello"],
  ]
  for (const [name, selection, written] of cases) {
    test(`${name} gives one insertText(${JSON.stringify(written)}, "After")`, async () => {
      const pane = await answered("Hello\n\n", { word: { selection } })
      await click(pane, "[data-control=insert]")
      // The preview shows the text without the D6 separator.
      expect(text(pane, "[data-part=preview-text]")).toBe("Hello")
      await click(pane, "[data-control=write]")
      expect(pane.word.doc.calls).toEqual([{ method: "insertText", text: written, location: "After" }])
    })
  }

  test("Replace passes the text unchanged with location Replace", async () => {
    const pane = await answered("Hello\n", { word: { selection: "Para\r" } })
    await click(pane, "[data-control=replace]")
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([{ method: "insertText", text: "Hello", location: "Replace" }])
  })
})

describe("U-UI-03 FR-48 buttons off while streaming, writing or empty; one confirm writes once", () => {
  test("streaming: no actions on the streaming reply, Insert/Replace off on earlier replies", async () => {
    const pane = await answered("First")
    await send(pane, "again", false)
    reply(pane, { id: "msg_b", text: "partial", idle: false })
    await settle()
    const replies = pane.qa("[data-part=reply]")
    expect(replies.length).toBe(2)
    expect(replies[1]!.querySelector("[data-control=insert]")).toBeNull()
    expect(disabled(replies[0]!.querySelector("[data-control=insert]"))).toBe(true)
    expect(disabled(replies[0]!.querySelector("[data-control=replace]"))).toBe(true)
    replies[0]!.querySelector<HTMLElement>("[data-control=insert]")!.click()
    await settle()
    expect(previews(pane).length).toBe(0)
  })

  test("empty reply: Insert, Replace and Copy are off and open nothing", async () => {
    const pane = await answered("")
    expect(disabled(pane.q("[data-control=insert]"))).toBe(true)
    expect(disabled(pane.q("[data-control=replace]"))).toBe(true)
    expect(disabled(pane.q("[data-control=copy]"))).toBe(true)
    await click(pane, "[data-control=insert]")
    expect(previews(pane).length).toBe(0)
  })

  test("while a write runs: Insert, Replace, Write and Send off, Copy on; a double click writes once", async () => {
    const hold = { release: () => {} }
    const gate = () => new Promise<void>((resolve) => (hold.release = resolve))
    const pane = await answered("Answer", { writeGate: gate })
    await click(pane, "[data-control=insert]")
    const write = pane.q("[data-control=write]")!
    write.click()
    write.click()
    await settle()
    expect(pane.controller.writing()).toBe(true)
    expect(disabled(pane.q("[data-control=insert]"))).toBe(true)
    expect(disabled(pane.q("[data-control=replace]"))).toBe(true)
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    expect(disabled(pane.q("[data-control=copy]"))).toBe(false)
    pane.controller.setDraft("next")
    await settle()
    expect(disabled(pane.q("[data-control=send]"))).toBe(true)
    // Copy works during the write.
    await click(pane, "[data-control=copy]")
    expect(pane.copied).toEqual(["Answer"])

    hold.release()
    await settle()
    expect(pane.word.doc.calls.length).toBe(1)
    expect(pane.controller.writing()).toBe(false)
    expect(previews(pane).length).toBe(0)
    expect(disabled(pane.q("[data-control=send]"))).toBe(false)
    // Closing after the write returns focus to the opener.
    expect(document.activeElement).toBe(pane.q("[data-control=insert]"))
  })
})

describe("U-UI-07 read and write failures keep the pane usable", () => {
  test("a read failure at Send shows readFailed and sends nothing", async () => {
    const pane = await track({ ...connected, word: { fault: "read" } })
    pane.controller.setDraft("question")
    await pane.controller.send()
    await settle()
    expect(text(pane, "[data-part=toast]")).toBe("Could not read from the document. Nothing was sent.Dismiss")
    expect(prompts(pane).length).toBe(0)
    expect(pane.controller.draft()).toBe("question")
    expect(disabled(pane.q("[data-control=send]"))).toBe(false)
  })

  test("a read failure at Insert closes the preview with readFailed; nothing written", async () => {
    const pane = await answered("Answer")
    pane.word.doc.fault = "read"
    await click(pane, "[data-control=insert]")
    expect(previews(pane).length).toBe(0)
    expect(pane.q("[data-part=toast]")!.textContent).toContain("Could not read from the document.")
    expect(pane.word.doc.calls).toEqual([])
  })

  test("a write failure (protected document) shows writeFailed, closes the preview, Send stays usable", async () => {
    const pane = await answered("Answer")
    await click(pane, "[data-control=insert]")
    pane.word.doc.fault = "write"
    await click(pane, "[data-control=write]")
    expect(previews(pane).length).toBe(0)
    expect(pane.q("[data-part=toast]")!.getAttribute("role")).toBe("alert")
    expect(pane.q("[data-part=toast]")!.textContent).toContain("Could not write to the document.")
    expect(pane.word.doc.calls).toEqual([])
    expect(pane.errors).toContain("write")
    expect(pane.controller.writing()).toBe(false)
    pane.controller.setDraft("next")
    await settle()
    expect(disabled(pane.q("[data-control=send]"))).toBe(false)
    expect(disabled(pane.q("[data-control=insert]"))).toBe(false)
  })
})

describe("U-UI-08 FR-49 / SC-44 re-read at the confirm click; a changed target needs another confirm", () => {
  test("Word: the selection moved after the preview -> new target shown, no write, second click writes", async () => {
    const pane = await answered("Hello", { word: { selection: "Para\r" } })
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview-target]")).toBe("After the selection")
    pane.word.doc.selection = ""
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([])
    expect(text(pane, "[data-part=preview-changed]")).toBe(
      "The selection changed. Check the new target, then confirm again.",
    )
    expect(pane.q("[data-part=preview-changed]")!.getAttribute("role")).toBe("alert")
    expect(text(pane, "[data-part=preview-target]")).toBe("At the cursor")
    expect(disabled(pane.q("[data-control=write]"))).toBe(false)
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([{ method: "insertText", text: "Hello", location: "After" }])
  })

  test("Word Replace: different selected text counts as a changed target", async () => {
    const pane = await answered("Hello", { word: { selection: "Old one" } })
    await click(pane, "[data-control=replace]")
    pane.word.doc.selection = "Other text"
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([])
    expect(text(pane, "[data-part=preview-removed]")).toBe("Other text")
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls.length).toBe(1)
  })

  test("Excel: the same cells on another sheet are a changed target (M8-03a)", async () => {
    const pane = await answered("5", { host: "Excel" })
    await click(pane, "[data-control=insert]")
    pane.excel.book.sheet = "Sheet2"
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
    expect(pane.q("[data-part=preview-changed]")).not.toBeNull()
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls.map((call) => call.method)).toEqual(["values", "select"])
  })

  test("Excel: the moved selection now hits filled cells -> refusal, Write disabled, nothing written", async () => {
    const pane = await answered("5", { host: "Excel", excel: { cells: { C3: "busy" } } })
    await click(pane, "[data-control=insert]")
    pane.excel.book.selection = { rowIndex: 1, columnIndex: 2, rowCount: 1, columnCount: 1 }
    await click(pane, "[data-control=write]")
    expect(pane.q("[data-part=preview-changed]")).not.toBeNull()
    expect(pane.q("[data-part=preview-refusal]")!.getAttribute("data-code")).toBe("office.error.targetNotEmpty")
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
  })
})

describe("U-UI-22 preview behaviour (FR-63)", () => {
  test("Insert reads the selection at the click, not before", async () => {
    const pane = await answered("Hello")
    const before = [...pane.reads]
    expect(before.some((entry) => entry.startsWith("preview:"))).toBe(false)
    await click(pane, "[data-control=insert]")
    expect(pane.reads.slice(before.length)).toEqual(["preview:insert"])
  })

  test("opening a second preview closes the first, also across replies", async () => {
    const pane = await answered("First")
    await send(pane, "again", false)
    reply(pane, { id: "msg_b", text: "Second" })
    await settle()
    const acts = pane.qa("[data-control=insert]")
    acts[0]!.click()
    await settle()
    pane.qa("[data-control=replace]")[0]!.click()
    await settle()
    expect(previews(pane).length).toBe(1)
    expect(text(pane, "[data-part=preview] h4")).toBe("Preview: Replace")
    pane.qa("[data-control=insert]")[1]!.click()
    await settle()
    expect(previews(pane).length).toBe(1)
    const second = pane.qa("[data-part=reply]")[1]!
    expect(second.querySelector("[data-part=preview]")).not.toBeNull()
  })

  test("Excel targetNotEmpty: danger strip, grid stays with the busy cell, Write disabled, no write", async () => {
    const pane = await answered("1\t2\n3\t4", { host: "Excel", excel: { cells: { A2: "kept" } } })
    await click(pane, "[data-control=insert]")
    const strip = pane.q("[data-part=preview-refusal]")!
    expect(strip.textContent).toBe("Some target cells are not empty. Nothing was written.")
    expect(strip.getAttribute("role")).toBe("alert")
    expect(pane.qa("[data-part=preview-grid] td").length).toBe(4)
    expect(pane.qa("[data-part=preview-grid] td.full").length).toBe(1)
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
  })

  test("Excel shapeMismatch shows the sizes; Write disabled", async () => {
    const pane = await answered("1\t2\t3\n4\t5\t6\n7\t8\t9", {
      host: "Excel",
      excel: { selection: { rowIndex: 0, columnIndex: 0, rowCount: 2, columnCount: 2 } },
    })
    await click(pane, "[data-control=replace]")
    expect(text(pane, "[data-part=preview-refusal]")).toBe(
      "The reply is 3 x 3 but the selection is 2 x 2. Select one cell or a range of the same size.",
    )
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
  })

  test("Excel cell too long: refusal shown before Write, nothing written", async () => {
    const pane = await answered("y".repeat(OFFICE_EXCEL_CELL_MAX_CHARS + 1), { host: "Excel" })
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=preview-refusal]")!.getAttribute("data-code")).toBe("office.error.writeFailed")
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    expect(pane.excel.book.calls).toEqual([])
  })

  test("Cancel and Esc close the preview and return focus to the opener", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    await click(pane, "[data-control=cancel]")
    expect(previews(pane).length).toBe(0)
    expect(document.activeElement).toBe(pane.q("[data-control=insert]"))
    await click(pane, "[data-control=replace]")
    key(pane.q("[data-control=write]")!, { key: "Escape" })
    await settle()
    expect(previews(pane).length).toBe(0)
    expect(document.activeElement).toBe(pane.q("[data-control=replace]"))
    // Enter on the preview (outside the Write button) writes nothing (FR-47, FR-61).
    await click(pane, "[data-control=insert]")
    key(pane.q("[data-part=preview] h4")!, { key: "Enter" })
    await settle()
    expect(pane.word.doc.calls).toEqual([])
  })

  test("the preview is inline in the reply, not a dialog (FR-43)", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=reply] [data-slot=preview] [data-part=preview]")).not.toBeNull()
    expect(pane.q("[role=dialog], dialog, [aria-modal]")).toBeNull()
  })
})

describe("U-UI-23 Excel grid preview (FR-63, C12, C14, C15)", () => {
  test("at most 8 rows x 5 columns, then the more line; headers from the target address", async () => {
    const answer = Array.from({ length: 10 }, (_, r) => Array.from({ length: 7 }, (_, c) => `r${r}c${c}`).join("\t")).join("\n")
    const pane = await answered(answer, { host: "Excel" })
    await click(pane, "[data-control=insert]")
    const grid = pane.q("[data-part=preview-grid] table")!
    expect(grid.getAttribute("role")).toBe("table")
    expect(grid.querySelectorAll("tbody tr").length).toBe(8)
    expect(grid.querySelectorAll("tbody tr")[0]!.querySelectorAll("td").length).toBe(5)
    expect([...grid.querySelectorAll("thead th[scope=col]")].map((th) => th.textContent)).toEqual(["A", "B", "C", "D", "E"])
    expect([...grid.querySelectorAll("tbody th[scope=row]")].map((th) => th.textContent)[0]).toBe("2")
    expect(text(pane, "[data-part=preview-more]")).toBe("+ 2 more rows, 2 more columns Show all")
    expect(text(pane, "[data-part=preview-target]")).toBe("Cells A2:G11 · 10 x 7 cells")
  })

  test("numbers right-aligned; formula-leading cells marked and counted, through the UI", async () => {
    const pane = await answered("=SUM(A1:A2)\t+1+1\t@x\t＝1+1\n-12.5\t42\t3e2\tword", { host: "Excel" })
    await click(pane, "[data-control=insert]")
    const cells = pane.qa("[data-part=preview-grid] td")
    const by = (value: string) => cells.find((cell) => cell.getAttribute("title") === value)!
    for (const value of ["=SUM(A1:A2)", "+1+1", "@x", "＝1+1"]) {
      expect(by(value).classList.contains("fx")).toBe(true)
      expect(by(value).getAttribute("data-kind")).toBe("kept-as-text")
    }
    for (const value of ["-12.5", "42", "3e2", "word"]) expect(by(value).classList.contains("fx")).toBe(false)
    expect(by("-12.5").classList.contains("num")).toBe(true)
    expect(by("42").classList.contains("num")).toBe(true)
    expect(by("3e2").classList.contains("num")).toBe(false)
    expect(text(pane, "[data-part=preview-formula]")).toBe(
      "4 cells look like formulas. They are written as text and will not calculate.",
    )
    // Written as text: numberFormat "@" first, then values (SC-45).
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls.map((call) => call.method)).toEqual(["numberFormat", "values", "select"])
  })

  test("a leading tab (not expressible inside a TSV reply cell) is marked by the grid", async () => {
    const view = renderGrid(["\t=1+1", "=SUM(A1:A2)", "-12.5", "42", "3e2"])
    const cells = [...view.container.querySelectorAll("td")]
    expect(cells.map((cell) => cell.classList.contains("fx"))).toEqual([true, true, false, false, false])
    expect(cells.map((cell) => cell.classList.contains("num"))).toEqual([false, false, true, true, false])
    view.dispose()
  })
})

describe("U-UI-18 read-only document (FR-60)", () => {
  test("banner, Insert and Replace off with the reason, Copy and Send on, no preview", async () => {
    const pane = await answered("Answer", { readOnly: true })
    expect(text(pane, "[data-part=read-only]")).toContain("read-only")
    for (const control of ["insert", "replace"]) {
      const button = pane.q(`[data-control=${control}]`)!
      expect(disabled(button)).toBe(true)
      expect(button.getAttribute("title")).toBe(text(pane, "[data-part=read-only] p"))
    }
    expect(disabled(pane.q("[data-control=copy]"))).toBe(false)
    pane.controller.setDraft("next")
    await settle()
    expect(disabled(pane.q("[data-control=send]"))).toBe(false)
    await click(pane, "[data-control=insert]")
    expect(previews(pane).length).toBe(0)
    expect(pane.reads.some((entry) => entry.startsWith("preview:"))).toBe(false)
  })

  test("a writable document shows no banner", async () => {
    const pane = await answered("Answer")
    expect(pane.q("[data-part=read-only]")).toBeNull()
  })
})

describe("U-UI-19 / ST-30 first-run notice per host (FR-43b, SC-50)", () => {
  test("static notice, Send off until acknowledged, flag per host, no provider lookup", async () => {
    const storage = memoryStore()
    const word = await track({ token: true, storage, partitionKey: "word" })
    const notice = word.q("[data-part=disclosure]")!
    expect(notice.textContent).toContain("By default this is the internal GSP-AI")
    expect(notice.closest("[role=dialog]")).toBeNull()
    const prompt = word.q("textarea")!
    expect(word.q(`#${prompt.getAttribute("aria-describedby")}`)!.textContent).toBe(en["office.prompt.ackFirst"])
    word.controller.setDraft("hello")
    await settle()
    expect(disabled(word.q("[data-control=send]"))).toBe(true)
    key(prompt, { key: "Enter" })
    await word.controller.send()
    await settle()
    expect(prompts(word).length).toBe(0)

    await click(word, "[data-control=disclosure-ack]")
    expect(storage.getItem("word:swarm.office.disclosureAck")).toBe("1")
    expect(word.q("[data-part=disclosure]")).toBeNull()
    expect(disabled(word.q("[data-control=send]"))).toBe(false)
    // No request was made to learn the provider.
    expect(word.bridge.requests.some((r) => /provider|config|model/i.test(r.path))).toBe(false)
    word.unmount()
    open.splice(open.indexOf(word), 1)

    const again = await track({ token: true, storage, partitionKey: "word" })
    expect(again.q("[data-part=disclosure]")).toBeNull()
    const excel = await track({ token: true, storage, partitionKey: "excel", host: "Excel" })
    expect(excel.q("[data-part=disclosure]")).not.toBeNull()
  })

  test("Indonesian notice text comes from the register", async () => {
    const pane = await track({ token: true, locale: "id" })
    expect(text(pane, "[data-part=disclosure] h4")).toBe("Sebelum mengirim")
    expect(text(pane, "[data-control=disclosure-ack]")).toBe("Saya mengerti")
  })
})

describe("provider line (C10, FR-59)", () => {
  test("an external providerID gets the warning style; the internal list does not", async () => {
    expect(isInternalProvider("gsp-ai-tail")).toBe(true)
    expect(isInternalProvider("openai")).toBe(false)
    expect(isInternalProvider(undefined)).toBe(false)
    const pane = await track(connected)
    await send(pane, "q")
    reply(pane, { text: "Answer", provider: "example-cloud" })
    await settle()
    const line = pane.q("[data-part=provider]")!
    expect(line.classList.contains("ext")).toBe(true)
    expect(line.getAttribute("role")).toBe("note")
    expect(line.textContent).toBe(
      "External provider: example-cloud · thinker. Content left GSP infrastructure and may be billed.",
    )
  })
})

describe("ST-23 unit half (SC-42..SC-44)", () => {
  test("no write without a click: reply, history restore and preview open never write", async () => {
    const pane = await answered("Answer")
    expect(pane.word.doc.calls).toEqual([])
    await click(pane, "[data-control=insert]")
    await click(pane, "[data-control=replace]")
    pane.clock.flushTimeouts()
    await settle()
    expect(pane.word.doc.calls).toEqual([])
  })
})

const tsv = (rows: number, cols: number) =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join("\t")).join("\n")

describe("M8-07a F-2 (SC-43): cells beyond the 8 x 5 window must be shown before Write", () => {
  test("10 x 7: Write disabled until Show all; then the full grid scrolls and Write writes", async () => {
    const pane = await answered(tsv(10, 7), { host: "Excel" })
    await click(pane, "[data-control=insert]")
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
    expect(text(pane, "[data-part=preview-more]")).toBe("+ 2 more rows, 2 more columns Show all")
    expect(text(pane, "[data-control=show-all]")).toBe("Show all")
    await click(pane, "[data-control=show-all]")
    expect(pane.q("[data-control=show-all]")).toBeNull()
    const grid = pane.q("[data-part=preview-grid] table")!
    expect(grid.closest(".grid-all")).not.toBeNull()
    expect(grid.querySelectorAll("tbody tr").length).toBe(10)
    expect(grid.querySelectorAll("tbody tr")[9]!.querySelectorAll("td").length).toBe(7)
    expect(grid.querySelectorAll("thead th[scope=col]").length).toBe(7)
    expect(pane.q("[data-part=preview-grid] td[title=r9c6]")).not.toBeNull()
    expect(disabled(pane.q("[data-control=write]"))).toBe(false)
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls.map((call) => `${call.method} ${call.address}`)).toEqual([
      "numberFormat A2:G11",
      "values A2:G11",
      "select A2:G11",
    ])
  })

  test(`above ${GRID_ALL_CELLS} cells Show all shows the whole payload as text; Write then enabled`, async () => {
    const answer = tsv(60, 40)
    const pane = await answered(answer, { host: "Excel" })
    await click(pane, "[data-control=insert]")
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
    await click(pane, "[data-control=show-all]")
    expect(text(pane, "[data-part=preview-all-text]")).toBe(answer)
    expect(pane.q("[data-part=preview-all-text]")!.previousElementSibling!.textContent).toBe("Full text that will be written")
    // The table keeps its 8 x 5 window; no 2,400-cell table is rendered.
    expect(pane.qa("[data-part=preview-grid] td").length).toBe(40)
    expect(disabled(pane.q("[data-control=write]"))).toBe(false)
  })

  test("exactly 8 x 5: nothing hidden, no Show all, Write enabled", async () => {
    const pane = await answered(tsv(8, 5), { host: "Excel" })
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-control=show-all]")).toBeNull()
    expect(disabled(pane.q("[data-control=write]"))).toBe(false)
  })

  test("a refused write still offers Show all; Write stays disabled", async () => {
    const pane = await answered(tsv(10, 2), { host: "Excel", excel: { cells: { A5: "busy" } } })
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=preview-refusal]")).not.toBeNull()
    await click(pane, "[data-control=show-all]")
    expect(pane.qa("[data-part=preview-grid] tbody tr").length).toBe(10)
    expect(disabled(pane.q("[data-control=write]"))).toBe(true)
  })
})

describe("M8-07a F-3 (SC-43, TB-3): invisible and format characters", () => {
  test("detector: Cf and tag characters counted; ordinary text not", () => {
    expect(invisibleCount("a​b‌c‍d⁠e﻿")).toBe(5)
    expect(invisibleCount("‪‫‬‭‮⁦⁧⁨⁩")).toBe(9)
    expect(invisibleCount("\u{E0001}\u{E0041}\u{E007F}\u{E0000}")).toBe(4)
    expect(invisibleCount("soft­hyphen")).toBe(1)
    expect(invisibleCount("Plain text, angka 42, tab\tand newline\n, emoji \u{1F600}")).toBe(0)
    expect(visibleText("a‮b\u{E0041}")).toBe("a⟨U+202E⟩b⟨U+E0041⟩")
  })

  test("Word: markers shown, count, first Write click only arms, second writes the text unchanged", async () => {
    const answer = "Pay​now ‮evil\u{E0041}"
    const pane = await answered(answer)
    await click(pane, "[data-control=insert]")
    const note = pane.q("[data-part=preview-invisible]")!
    expect(note.getAttribute("data-count")).toBe("3")
    expect(note.getAttribute("role")).toBe("alert")
    expect(note.textContent).toBe(
      "3 hidden characters will be written. They are shown as markers below. Click Write again to confirm. ⟨U+200B⟩ ⟨U+202E⟩ ⟨U+E0041⟩",
    )
    expect(text(pane, "[data-part=preview-text]")).toBe("Pay⟨U+200B⟩now ⟨U+202E⟩evil⟨U+E0041⟩")
    expect(pane.qa("[data-part=preview-text] [data-part=invisible-mark]").length).toBe(3)
    const write = pane.q("[data-control=write]")!
    expect(write.getAttribute("aria-describedby")).toBe(note.id)

    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([])
    expect(pane.q("[data-control=write]")!.getAttribute("data-confirm")).toBe("again")
    expect(document.activeElement).toBe(note)
    await click(pane, "[data-control=write]")
    // Unchanged content; the default harness selection ends with a paragraph mark, so D6 appends "\n".
    expect(pane.word.doc.calls).toEqual([{ method: "insertText", text: `${answer}\n`, location: "After" }])
  })

  test("a changed target after arming still needs its own confirm and writes once", async () => {
    const pane = await answered("x​y", { word: { selection: "Para\r" } })
    await click(pane, "[data-control=insert]")
    await click(pane, "[data-control=write]")
    pane.word.doc.selection = ""
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([])
    expect(pane.q("[data-part=preview-changed]")).not.toBeNull()
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls.length).toBe(1)
  })

  test("Excel: the cell shows the marker in text and title; second confirm required", async () => {
    const pane = await answered("﻿total\t5", { host: "Excel" })
    await click(pane, "[data-control=insert]")
    const cell = pane.q("[data-part=preview-grid] td")!
    expect(cell.textContent).toBe("⟨U+FEFF⟩total")
    expect(cell.getAttribute("title")).toBe("⟨U+FEFF⟩total")
    expect(pane.q("[data-part=preview-invisible]")!.getAttribute("data-count")).toBe("1")
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls).toEqual([])
    await click(pane, "[data-control=write]")
    expect(pane.excel.book.calls.map((call) => call.method)).toEqual(["numberFormat", "values", "select"])
  })

  test("plain text: no note and one click writes", async () => {
    const pane = await answered("Plain")
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=preview-invisible]")).toBeNull()
    expect(pane.q("[data-control=write]")!.getAttribute("aria-describedby")).toBeNull()
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls.length).toBe(1)
  })
})

describe("M8-07b rev 6 strings in Indonesian", () => {
  test("the warning, Show all and full-text label come from id.ts", async () => {
    const pane = await answered("a\u200Bb", { locale: "id" })
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview-invisible]")).toContain(
      "1 karakter tersembunyi akan ikut ditulis. Karakter itu ditampilkan sebagai penanda di bawah. Klik Tulis sekali lagi untuk mengonfirmasi.",
    )
    const excel = await answered(tsv(9, 2), { host: "Excel", locale: "id" })
    await click(excel, "[data-control=insert]")
    expect(text(excel, "[data-control=show-all]")).toBe("Tampilkan semua")
  })
})

describe("M8-03d tracked anchor release (C70)", () => {
  const releases = (pane: Mounted) => pane.word.doc.releases.length

  test("Cancel releases the previewed anchor exactly once", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    expect(releases(pane)).toBe(0)
    await click(pane, "[data-control=cancel]")
    expect(releases(pane)).toBe(1)
    await settle()
    expect(releases(pane)).toBe(1)
  })

  test("Esc and opening another preview each release the held anchor once", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    key(pane.q("[data-control=write]")!, { key: "Escape" })
    await settle()
    expect(releases(pane)).toBe(1)
    await click(pane, "[data-control=insert]")
    await click(pane, "[data-control=replace]")
    expect(releases(pane)).toBe(2)
    await click(pane, "[data-control=cancel]")
    expect(releases(pane)).toBe(3)
  })

  test("a successful write releases once (inside write), with no second release on close", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls.length).toBe(1)
    expect(releases(pane)).toBe(1)
    await settle()
    expect(releases(pane)).toBe(1)
  })

  test("changed target: the old anchor goes with write, the new one once on Cancel", async () => {
    const pane = await answered("Hello", { word: { selection: "Para\r", position: 1 } })
    await click(pane, "[data-control=insert]")
    pane.word.doc.position = 2
    await click(pane, "[data-control=write]")
    expect(pane.word.doc.calls).toEqual([])
    expect(pane.word.doc.releases).toEqual([{ kind: "memory", position: 1 }])
    await click(pane, "[data-control=cancel]")
    expect(pane.word.doc.releases).toEqual([
      { kind: "memory", position: 1 },
      { kind: "memory", position: 2 },
    ])
  })

  test("a failed write releases once and the close adds none", async () => {
    const pane = await answered("Hello")
    await click(pane, "[data-control=insert]")
    pane.word.doc.fault = "write"
    await click(pane, "[data-control=write]")
    expect(previews(pane).length).toBe(0)
    expect(releases(pane)).toBe(1)
  })

  test("a preview closed before its read returns still releases once", async () => {
    const pane = await answered("Hello")
    pane.q("[data-control=insert]")!.click()
    pane.controller.closePreview()
    await settle()
    expect(releases(pane)).toBe(1)
  })
})

describe("M8-07c (C93) counts in the preview: singular and plural", () => {
  test("Word: 1 paragraph / 1 character vs 2 paragraphs", async () => {
    const one = await answered("A")
    await click(one, "[data-control=insert]")
    expect(text(one, "[data-part=preview-counts]")).toBe("1 character · 1 paragraph")
    const two = await answered("Hi\nyo")
    await click(two, "[data-control=insert]")
    expect(text(two, "[data-part=preview-counts]")).toBe("5 characters · 2 paragraphs")
  })

  test("Excel: 1 cell looks like a formula vs 2 cells", async () => {
    const one = await answered("=A1\tx", { host: "Excel" })
    await click(one, "[data-control=insert]")
    expect(text(one, "[data-part=preview-formula]")).toBe(
      "1 cell looks like a formula. It is written as text and will not calculate.",
    )
    const two = await answered("=A1\t+B2", { host: "Excel" })
    await click(two, "[data-control=insert]")
    expect(text(two, "[data-part=preview-formula]")).toBe(
      "2 cells look like formulas. They are written as text and will not calculate.",
    )
  })

  test("1 hidden character uses the singular warning", async () => {
    const pane = await answered("a\u200Bb")
    await click(pane, "[data-control=insert]")
    expect(text(pane, "[data-part=preview-invisible]")).toBe(
      "1 hidden character will be written. It is shown as a marker below. Click Write again to confirm. \u27e8U+200B\u27e9",
    )
  })
})
