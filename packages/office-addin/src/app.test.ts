// Pane shell component tests (plan M8-05): U-UI-01, U-UI-02, U-UI-12, U-UI-21, U-UI-25, the
// startup /pair/verify check (controller note CP-M4 I-4) and the composer keys of FR-61.
import { afterEach, describe, expect, test } from "bun:test"
import "./views/solid-test"

const { mount, settle, frames, TOKEN } = await import("./views/harness")
const { resolveScheme, watchScheme, luminance } = await import("./views/theme")

type Mounted = Awaited<ReturnType<typeof mount>>
const open: Mounted[] = []
const track = async (...args: Parameters<typeof mount>) => {
  const pane = await mount(...args)
  open.push(pane)
  return pane
}
afterEach(() => open.splice(0).forEach((pane) => pane.unmount()))

const SES = "ses_new"

// Sends `text` and opens the stream; returns once the user turn and the busy state exist.
async function send(pane: Mounted, text: string) {
  pane.controller.setDraft(text)
  const sent = pane.controller.send()
  await pane.bridge.streamOpened
  pane.bridge.push(frames.connected)
  await sent
  await settle()
}

function reply(pane: Mounted, text: string, extra: Record<string, unknown> = { providerID: "gsp-ai-tail", modelID: "thinker" }) {
  pane.bridge.push(frames.message(SES, "msg_user", "user"))
  pane.bridge.push(frames.part(SES, "msg_user", "prt_user", "text"))
  pane.bridge.push(frames.delta(SES, "msg_user", "prt_user", "echo of the prompt"))
  pane.bridge.push(frames.message(SES, "msg_a", "assistant", extra))
  pane.bridge.push(frames.part(SES, "msg_a", "prt_r", "reasoning"))
  pane.bridge.push(frames.delta(SES, "msg_a", "prt_r", "thinking aloud"))
  pane.bridge.push(frames.part(SES, "msg_a", "prt_a", "text"))
  pane.bridge.push(frames.delta(SES, "msg_a", "prt_a", text))
}

const connected = { token: true, acknowledged: true }

describe("U-UI-01 control inventory per state (FS §8.1, §9.1)", () => {
  test("loading, unsupported-host, unavailable, unpaired, pairing, denied", async () => {
    const loading = await track({ noOffice: true })
    expect(loading.controls()).toEqual([])

    const unsupported = await track({ host: "PowerPoint" })
    expect(unsupported.controller.conn().name).toBe("unsupported-host")
    expect(unsupported.controls()).toEqual([])

    const unavailable = await track({
      bridge: { handler: (r) => (r.path === "/bridge/health" ? { status: 200, body: { swarm: "starting" } } : undefined) },
    })
    expect(unavailable.controller.conn().name).toBe("unavailable")
    expect(unavailable.controls()).toEqual(["retry"])

    const unpaired = await track()
    expect(unpaired.controller.conn().name).toBe("unpaired")
    expect(unpaired.controls()).toEqual(["connect"])

    unpaired.q("[data-control=connect]")!.click()
    await settle()
    expect(unpaired.controller.conn().name).toBe("pairing")
    expect(unpaired.controls()).toEqual([])
    expect(unpaired.q("[data-part=pairing-code]")!.textContent).toBe("4821")

    const denied = await track({
      bridge: { handler: (r) => (r.path === "/pair/status" ? { status: 200, body: { state: "denied" } } : undefined) },
    })
    denied.q("[data-control=connect]")!.click()
    await settle()
    denied.clock.tick(1000)
    await settle()
    expect(denied.controller.conn().name).toBe("denied")
    expect(denied.controls()).toEqual(["connect"])
  })

  test("connected: first run, idle with a reply, streaming; no tabs, settings, locale, agent or model picker", async () => {
    const first = await track({ token: true })
    expect(first.controller.conn().name).toBe("connected")
    expect(first.controls()).toEqual(["chat-select", "new-chat", "disclosure-ack", "context", "prompt", "send"])
    expect(first.q("[data-control=send]")!.getAttribute("aria-disabled")).toBe("true")

    const pane = await track(connected)
    expect(pane.controls()).toEqual(["chat-select", "new-chat", "context", "prompt", "send"])
    await send(pane, "Summarise")
    expect(pane.controls()).toEqual(["chat-select", "new-chat", "context", "prompt", "stop"])
    reply(pane, "Done.")
    pane.bridge.push(frames.idle(SES))
    await settle()
    expect(pane.controls()).toEqual(["chat-select", "new-chat", "insert", "replace", "copy", "context", "prompt", "send"])
    expect(pane.qa("[role=tab], [role=tablist], dialog, [role=dialog]").length).toBe(0)
    expect(pane.qa("select").length).toBe(1)
  })

  test("the preview slot renders only through the M8-06/07 render prop, under the reply that asked", async () => {
    const pane = await track({ ...connected, preview: (input) => input.request.action })
    await send(pane, "Summarise")
    reply(pane, "Done.")
    pane.bridge.push(frames.idle(SES))
    await settle()
    expect(pane.qa("[data-slot=preview]").length).toBe(0)
    pane.q("[data-control=insert]")!.click()
    await settle()
    const slot = pane.q("[data-slot=preview]")!
    expect(slot.closest("[data-part=reply]")).not.toBeNull()
    expect(slot.textContent).toBe("insert")
    expect(pane.word.doc.calls).toEqual([])
  })
})

describe("U-UI-02 replies are plain text (SC-40, FR-41)", () => {
  test("HTML, Markdown and URLs render as literal text with no element children; whitespace kept", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    const text = '<img src=x onerror=alert(1)> <script>alert(2)</script>\n**md**  ![x](https://attacker.example/p)\thttps://example.com'
    reply(pane, text)
    pane.bridge.push(frames.idle(SES))
    await settle()
    const box = pane.q("[data-part=reply-text]")!
    expect(box.textContent).toBe(text)
    expect(box.children.length).toBe(0)
    expect(pane.qa("img, script, a").length).toBe(0)
  })

  test("only assistant text parts are shown: no user echo, no reasoning (D5b)", async () => {
    const pane = await track(connected)
    await send(pane, "Summarise")
    reply(pane, "Answer")
    await settle()
    const thread = pane.q("[data-part=thread]")!.textContent ?? ""
    expect(thread).not.toContain("echo of the prompt")
    expect(thread).not.toContain("thinking aloud")
    expect(pane.q("[data-part=reply-text]")!.textContent).toBe("Answer")
  })
})

describe("U-UI-12 status dot (FR-55)", () => {
  const expectStatus = (pane: Mounted, tone: string, label: string, pulse = false) => {
    const dot = pane.q("[data-part=status] .dot")!
    expect(dot.getAttribute("data-tone")).toBe(tone)
    expect(dot.classList.contains("pulse")).toBe(pulse)
    expect(pane.q("[data-part=status] .st-label")!.textContent).toBe(label)
    expect(pane.q("[data-part=status]")!.getAttribute("aria-live")).toBe("polite")
  }

  test("each of the seven states maps to its tone and label", async () => {
    expectStatus(await track({ noOffice: true }), "grey", "Loading Swarm", true)
    expectStatus(await track({ host: "PowerPoint" }), "grey", "")
    expectStatus(
      await track({ bridge: { handler: (r) => (r.path === "/bridge/health" ? { status: 503 } : undefined) } }),
      "red",
      "Not reachable",
    )
    const unpaired = await track()
    expectStatus(unpaired, "grey", "Not connected")
    unpaired.q("[data-control=connect]")!.click()
    await settle()
    expectStatus(unpaired, "amber", "Waiting for approval")
    const denied = await track({
      bridge: { handler: (r) => (r.path === "/pair/status" ? { status: 200, body: { state: "denied" } } : undefined) },
    })
    denied.q("[data-control=connect]")!.click()
    await settle()
    denied.clock.tick(1000)
    await settle()
    expectStatus(denied, "red", "Declined")
    expectStatus(await track(connected), "green", "Connected")
  })

  test("a state change replaces the label text once", async () => {
    const pane = await track()
    const label = pane.q("[data-part=status] .st-label")!
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(label.textContent ?? ""))
    observer.observe(label, { childList: true, characterData: true, subtree: true })
    pane.q("[data-control=connect]")!.click()
    await settle()
    observer.disconnect()
    expect(seen.filter((text) => text === "Waiting for approval").length).toBe(1)
  })
})

describe("startup /pair/verify (CP-M4 I-4, FS T6/T7)", () => {
  test("a stored token is verified once on load; 204 connects", async () => {
    const pane = await track({ token: true })
    const verify = pane.bridge.requests.filter((r) => r.path === "/pair/verify")
    expect(verify.length).toBe(1)
    expect(verify[0]!.headers["x-swarm-office-token"]).toBe(TOKEN)
    expect(pane.controller.conn().name).toBe("connected")
  })

  test("401 clears the token and every session key, then shows unpaired", async () => {
    const pane = await track({
      token: true,
      bridge: { handler: (r) => (r.path === "/pair/verify" ? { status: 401, body: { error: "TOKEN_INVALID" } } : undefined) },
    })
    expect(pane.controller.conn().name).toBe("unpaired")
    expect(pane.storage.getItem("swarm.office.token")).toBeNull()
    expect(pane.controls()).toEqual(["connect"])
  })

  test("no stored token: no verify call, unpaired, and no pair request until Connect (FR-30)", async () => {
    const pane = await track()
    expect(pane.bridge.requests.some((r) => r.path === "/pair/verify")).toBe(false)
    expect(pane.bridge.requests.some((r) => r.path === "/pair/request")).toBe(false)
    expect(pane.controller.conn().name).toBe("unpaired")
  })
})

describe("U-UI-21 theme (FR-62)", () => {
  test("isDarkTheme, luminance rule, and the prefers-color-scheme fallback", () => {
    expect(resolveScheme({ isDarkTheme: true }, false)).toBe("dark")
    expect(resolveScheme({ isDarkTheme: false }, true)).toBe("light")
    expect(resolveScheme({ bodyBackgroundColor: "#1f1f1f" }, false)).toBe("dark")
    expect(resolveScheme({ bodyBackgroundColor: "#ffffff" }, true)).toBe("light")
    expect(luminance("#777777")! < 0.5).toBe(true)
    expect(resolveScheme(undefined, true)).toBe("dark")
    expect(resolveScheme(undefined, false)).toBe("light")
  })

  test("both change events update data-color-scheme", () => {
    const root = document.createElement("div")
    const listeners: (() => void)[] = []
    const officeListeners: (() => void)[] = []
    const media = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
      removeEventListener: () => {},
    }
    const theme = { value: undefined as { isDarkTheme?: boolean } | undefined }
    watchScheme({
      officeTheme: () => theme.value,
      media: media as never,
      root,
      subscribeOffice: (fn) => void officeListeners.push(fn),
    })
    expect(root.dataset.colorScheme).toBe("light")
    media.matches = true
    listeners.forEach((fn) => fn())
    expect(root.dataset.colorScheme).toBe("dark")
    theme.value = { isDarkTheme: false }
    officeListeners.forEach((fn) => fn())
    expect(root.dataset.colorScheme).toBe("light")
  })
})

describe("U-UI-25 accessibility (design §9)", () => {
  test("thread role=log without aria-live; one live region announces Reply finished once", async () => {
    const pane = await track(connected)
    const thread = pane.q("[data-part=thread]")!
    expect(thread.getAttribute("role")).toBe("log")
    expect(thread.hasAttribute("aria-live")).toBe(false)
    expect(pane.qa("[aria-live]").map((el) => el.getAttribute("data-part"))).toEqual(["status", "live"])
    await send(pane, "x")
    reply(pane, "Hello")
    await settle()
    expect(pane.q("[data-part=live]")!.textContent).not.toBe("Reply finished")
    pane.bridge.push(frames.idle(SES))
    await settle()
    expect(pane.q("[data-part=live]")!.textContent).toBe("Reply finished")
  })

  test("error toasts use role=alert and stay; success uses role=status", async () => {
    const pane = await track(connected)
    pane.controller.setDraft("x")
    pane.word.doc.fault = "read"
    await pane.controller.send()
    await settle()
    const toast = pane.q("[data-part=toast]")!
    expect(toast.getAttribute("role")).toBe("alert")
    expect(toast.textContent).toContain("Could not read from the document. Nothing was sent.")
    pane.clock.flushTimeouts()
    await settle()
    expect(pane.q("[data-part=toast]")).not.toBeNull()
    pane.q("[data-control=toast-dismiss]")!.click()
    await settle()
    expect(pane.q("[data-part=toast]")).toBeNull()
  })

  test("every icon button has an aria-label; DOM order equals the focus order of design §9.1", async () => {
    const pane = await track({ token: true })
    pane.word.doc.fault = "read"
    pane.controller.acknowledge()
    pane.controller.setDraft("x")
    await pane.controller.send()
    await settle()
    for (const button of pane.qa("button.ib")) expect(button.getAttribute("aria-label")).toBeTruthy()
    expect(pane.controls()).toEqual(["toast-dismiss", "chat-select", "new-chat", "context", "prompt", "send"])
  })

  test("under reduced motion no animation class is applied", async () => {
    const still = await track({ noOffice: true, reducedMotion: true })
    expect(still.q(".dot")!.classList.contains("pulse")).toBe(false)
    expect(still.q(".spin")!.classList.contains("rotate")).toBe(false)
    const moving = await track({ noOffice: true })
    expect(moving.q(".dot")!.classList.contains("pulse")).toBe(true)
    expect(moving.q(".spin")!.classList.contains("rotate")).toBe(true)

    const pane = await track({ ...connected, reducedMotion: true })
    await send(pane, "x")
    expect(pane.q("[data-part=waiting] .caret")!.classList.contains("blink")).toBe(false)
  })

  test("the pairing code is focused and read digit by digit", async () => {
    const pane = await track()
    pane.q("[data-control=connect]")!.click()
    await settle()
    const code = pane.q("[data-part=pairing-code]")!
    expect(code.getAttribute("aria-label")).toBe("Pairing code 4 8 2 1")
    expect(document.activeElement).toBe(code)
  })
})

describe("composer (FR-26, FR-43b, FR-61, FR-64, AC-15)", () => {
  const key = (el: Element, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))

  test("Enter sends, Shift+Enter and IME Enter do not; waiting text appears in the same tick", async () => {
    const pane = await track(connected)
    const field = pane.q<HTMLTextAreaElement>("[data-control=prompt]")!
    pane.controller.setDraft("Hello")
    key(field, { key: "Enter", shiftKey: true })
    key(field, { key: "Enter", isComposing: true })
    expect(pane.marks).toEqual([])
    key(field, { key: "Enter" })
    expect(pane.marks).toEqual(["swarm.office.send", "swarm.office.busy"])
    expect(pane.q("[data-part=waiting]")!.textContent).toBe("Thinking")
    expect(pane.q("[data-part=user-turn]")!.textContent).toContain("Hello")
    await pane.bridge.streamOpened
    pane.bridge.push(frames.connected)
    await settle()
    expect(pane.q("[data-part=user-turn] .tag")!.textContent).toBe("Selection · 14 characters")
  })

  test("Send is blocked until the disclosure is acknowledged (SC-50)", async () => {
    const pane = await track({ token: true })
    pane.controller.setDraft("Hello")
    await pane.controller.send()
    expect(pane.bridge.requests.some((r) => r.path.endsWith("/prompt_async"))).toBe(false)
    expect(pane.q("[data-part=disclosure]")).not.toBeNull()
    pane.q("[data-control=disclosure-ack]")!.click()
    await settle()
    expect(pane.q("[data-part=disclosure]")).toBeNull()
    expect(pane.storage.getItem("swarm.office.disclosureAck")).toBe("1")
  })

  test("Stop sends abort and keeps the text with the Stopped tag", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, "Partial")
    await settle()
    pane.q("[data-control=stop]")!.click()
    await settle()
    expect(pane.bridge.requests.some((r) => r.path.endsWith("/abort"))).toBe(true)
    expect(pane.q("[data-part=reply]")!.textContent).toContain("Partial")
    expect(pane.q(".rtag")!.textContent).toBe("Stopped")
  })

  test("provider line: internal and external (FR-59)", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, "A", { providerID: "example-cloud", modelID: "m1" })
    pane.bridge.push(frames.idle(SES))
    await settle()
    const line = pane.q("[data-part=provider]")!
    expect(line.getAttribute("data-provider")).toBe("external")
    expect(line.textContent).toBe(
      "External provider: example-cloud · m1. Content left GSP infrastructure and may be billed.",
    )
  })

  test("read-only document: banner, Insert and Replace off, Copy on (FR-60)", async () => {
    const pane = await track({ ...connected, readOnly: true })
    expect(pane.q("[data-part=read-only]")!.textContent).toContain("read-only")
    await send(pane, "x")
    reply(pane, "Copy me")
    pane.bridge.push(frames.idle(SES))
    await settle()
    expect(pane.q("[data-control=insert]")!.getAttribute("aria-disabled")).toBe("true")
    expect(pane.q("[data-control=replace]")!.getAttribute("aria-disabled")).toBe("true")
    pane.q("[data-control=copy]")!.click()
    await settle()
    expect(pane.copied).toEqual(["Copy me"])
    expect(pane.q("[data-control=copy]")!.textContent).toBe("Copied")
    expect(pane.word.doc.calls).toEqual([])
  })

  test("Excel: whole option reads Used range; the sent tag names the cells (FR-58)", async () => {
    const pane = await track({
      ...connected,
      host: "Excel",
      excel: { cells: { B2: "a", C2: 1 }, selection: { rowIndex: 1, columnIndex: 1, rowCount: 1, columnCount: 2 } },
    })
    expect(pane.q("[data-scope=whole]")!.textContent).toBe("Used range")
    await send(pane, "x")
    expect(pane.q("[data-part=user-turn] .tag")!.textContent).toBe("Selection · B2:C2 · 1 x 2 cells")
  })
})
