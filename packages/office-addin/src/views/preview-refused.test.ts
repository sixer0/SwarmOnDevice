// M8-03b (C59): a refused Excel write names its cells and labels the grid (mockup S13,
// "Cells B10:D12"). The real App over the in-memory bridge and host adapters.
import { afterEach, describe, expect, test } from "bun:test"
import "./solid-test"

const { mount, settle, frames } = await import("./harness")

type Mounted = Awaited<ReturnType<typeof mount>>
const open: Mounted[] = []
afterEach(() => open.splice(0).forEach((pane) => pane.unmount()))

const SES = "ses_new"
const text = (pane: Mounted, selector: string) => pane.q(selector)?.textContent ?? ""
const headers = (pane: Mounted, selector: string) => pane.qa(selector).map((th) => th.textContent)

async function answered(answer: string, options: Parameters<typeof mount>[0]) {
  const pane = await mount({ token: true, acknowledged: true, ...options })
  open.push(pane)
  pane.controller.setDraft("question")
  const sent = pane.controller.send()
  await pane.bridge.streamOpened
  pane.bridge.push(frames.connected)
  await sent
  await settle()
  pane.bridge.push(frames.message(SES, "msg_a", "assistant", { providerID: "gsp-ai-tail", modelID: "thinker" }))
  pane.bridge.push(frames.part(SES, "msg_a", "msg_a_pt", "text"))
  pane.bridge.push(frames.delta(SES, "msg_a", "msg_a_pt", answer))
  pane.bridge.push(frames.idle(SES))
  await settle()
  return pane
}

async function click(pane: Mounted, selector: string) {
  pane.q(selector)!.click()
  await settle()
}

describe("M8-03b refused Excel grid: address and headers (mockup S13)", () => {
  test("targetNotEmpty: Cells B10:D12, columns B..D, rows 10..12, busy cell marked, nothing written", async () => {
    const pane = await answered("a\tb\tc\nd\te\tf\ng\th\ti", {
      host: "Excel",
      excel: {
        selection: { rowIndex: 8, columnIndex: 1, rowCount: 1, columnCount: 3 },
        cells: { C11: "busy" },
      },
    })
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=preview-refusal]")!.getAttribute("data-code")).toBe("office.error.targetNotEmpty")
    expect(text(pane, "[data-part=preview-target]")).toBe("Cells B10:D12 · 3 x 3 cells")
    expect(pane.q("[data-part=preview-target]")!.getAttribute("data-address")).toBe("Sheet1!B10:D12")
    expect(headers(pane, "[data-part=preview-grid] thead th[scope=col]")).toEqual(["B", "C", "D"])
    expect(headers(pane, "[data-part=preview-grid] tbody th[scope=row]")).toEqual(["10", "11", "12"])
    const full = pane.qa("[data-part=preview-grid] td.full")
    expect(full.map((td) => td.textContent)).toEqual(["e"])
    expect(pane.excel.book.calls).toEqual([])
  })

  test("shapeMismatch names the selection with its size and headers", async () => {
    const pane = await answered("1\t2\t3\n4\t5\t6\n7\t8\t9", {
      host: "Excel",
      excel: { selection: { rowIndex: 4, columnIndex: 2, rowCount: 2, columnCount: 2 } },
    })
    await click(pane, "[data-control=replace]")
    expect(pane.q("[data-part=preview-refusal]")!.getAttribute("data-code")).toBe("office.error.shapeMismatch")
    expect(text(pane, "[data-part=preview-target]")).toBe("Cells C5:D6 · 2 x 2 cells")
    expect(headers(pane, "[data-part=preview-grid] thead th[scope=col]")).toEqual(["C", "D", "E"])
    expect(headers(pane, "[data-part=preview-grid] tbody th[scope=row]")).toEqual(["5", "6", "7"])
    expect(pane.excel.book.calls).toEqual([])
  })

  test("cell too long (writeFailed) names the planned target", async () => {
    const pane = await answered("y".repeat(32_768), {
      host: "Excel",
      excel: { selection: { rowIndex: 0, columnIndex: 0, rowCount: 1, columnCount: 1 } },
    })
    await click(pane, "[data-control=insert]")
    expect(pane.q("[data-part=preview-refusal]")!.getAttribute("data-code")).toBe("office.error.writeFailed")
    expect(text(pane, "[data-part=preview-target]")).toBe("Cells A2 · 1 x 1 cells")
    expect(pane.excel.book.calls).toEqual([])
  })
})
