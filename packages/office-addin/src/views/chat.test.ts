// Chat UI component tests (plan M8-06): U-UI-04, U-UI-05, U-UI-06, U-UI-09, U-UI-13..U-UI-17,
// U-UI-20, U-UI-24, plus the FR-25 draft-size guard and the Copy fallback (H-UI-3).
// The real App over the in-memory bridge, host adapters, storage and manual timers (harness.tsx).
import { afterEach, describe, expect, test } from "bun:test"
import "./solid-test"
import type { Recorded, Route } from "../api/fake-bridge"
import { OFFICE_BODY_LIMIT_BYTES, OFFICE_SESSION_STORAGE_PREFIX } from "../constants"
import { docKey } from "../state/session"
import { memoryStore } from "../state/test-store"

const { mount, settle, frames } = await import("./harness")
const { copyText } = await import("./chat-clipboard")
const { draftTooLarge } = await import("./controller")

type Mounted = Awaited<ReturnType<typeof mount>>
const open: Mounted[] = []
const track = async (...args: Parameters<typeof mount>) => {
  const pane = await mount(...args)
  open.push(pane)
  return pane
}
afterEach(() => open.splice(0).forEach((pane) => pane.unmount()))

const SES = "ses_new"
const URL_ = "/Users/test/Doc.docx"
const connected = { token: true, acknowledged: true }
const key = (el: Element, init: KeyboardEventInit) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))

const prompts = (pane: Mounted) => pane.bridge.requests.filter((r) => r.path.endsWith("/prompt_async"))
const text = (pane: Mounted, selector: string) => pane.q(selector)?.textContent ?? ""

// Sends `draft` through the controller; the first call also opens the event stream.
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

// One assistant reply with a user echo and reasoning around it (D5b).
function reply(
  pane: Mounted,
  input: { session?: string; id?: string; text: string; extra?: Record<string, unknown>; idle?: boolean },
) {
  const ses = input.session ?? SES
  const id = input.id ?? "msg_a"
  pane.bridge.push(frames.message(ses, `${id}_u`, "user"))
  pane.bridge.push(frames.part(ses, `${id}_u`, `${id}_pu`, "text"))
  pane.bridge.push(frames.delta(ses, `${id}_u`, `${id}_pu`, "echo of the prompt"))
  pane.bridge.push(frames.message(ses, id, "assistant", input.extra ?? { providerID: "gsp-ai-tail", modelID: "thinker" }))
  pane.bridge.push(frames.part(ses, id, `${id}_pr`, "reasoning"))
  pane.bridge.push(frames.delta(ses, id, `${id}_pr`, "thinking aloud"))
  pane.bridge.push(frames.part(ses, id, `${id}_pt`, "text"))
  pane.bridge.push(frames.delta(ses, id, `${id}_pt`, input.text))
  if (input.idle !== false) pane.bridge.push(frames.idle(ses))
}

const summary = (id: string, title: string, updated: number, host = "Word") => ({
  id,
  slug: id,
  projectID: "p",
  directory: "/office",
  title,
  version: "1",
  time: { created: 1, updated },
  metadata: { "swarm.origin": "office-addin", "swarm.office.host": host },
})

const history = (sessionID: string) => [
  { info: { id: `${sessionID}_u1`, role: "user", sessionID }, parts: [{ type: "text", text: "Earlier question" }] },
  {
    info: { id: `${sessionID}_a1`, role: "assistant", sessionID, providerID: "gsp-ai-tail", modelID: "thinker" },
    parts: [{ type: "text", text: `Earlier answer of ${sessionID}` }],
  },
]

// Bridge with a recent list and per-session titles and history.
function chats(list: ReturnType<typeof summary>[]) {
  return (r: Recorded): Route | undefined => {
    if (r.method === "GET" && r.path === "/swarm/session") return { status: 200, body: list }
    const match = /^\/swarm\/session\/([^/]+)(\/message)?$/.exec(r.path)
    if (r.method !== "GET" || !match?.[1]) return undefined
    const id = match[1]
    if (match[2]) return { status: 200, body: history(id) }
    return { status: 200, body: list.find((item) => item.id === id) ?? summary(id, `Title ${id}`, 1) }
  }
}

async function storedSession(storage: ReturnType<typeof memoryStore>, sessionID: string) {
  storage.setItem(OFFICE_SESSION_STORAGE_PREFIX + (await docKey(URL_)), sessionID)
}

const pick = async (pane: Mounted, sessionID: string) => {
  const select = pane.q<HTMLSelectElement>("[data-control=chat-select]")!
  select.value = sessionID
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await settle()
}

const options = (pane: Mounted) => pane.qa<HTMLOptionElement>("[data-control=chat-select] option").map((o) => o.textContent)

describe("U-UI-04 no silent write (AC-28, AC-37)", () => {
  test("reply arrival, chat restore, Recent switch, New chat and 5 full turns write nothing", async () => {
    const storage = memoryStore()
    await storedSession(storage, "ses_old")
    const list = [summary("ses_old", "Old chat", 5), summary("ses_other", "Other chat", 4)]
    const pane = await track({ ...connected, storage, bridge: { handler: chats(list) } })
    expect(text(pane, "[data-part=thread]")).toContain("Earlier answer of ses_old")

    for (const turn of [1, 2, 3, 4, 5]) {
      await send(pane, `Question ${turn}`, turn === 1)
      reply(pane, { session: "ses_old", id: `msg_${turn}`, text: `Answer ${turn}` })
      await settle()
    }
    expect(pane.qa("[data-part=reply-text]").map((el) => el.textContent)).toContain("Answer 5")
    expect(prompts(pane).length).toBe(5)

    await pick(pane, "ses_other")
    expect(text(pane, "[data-part=thread]")).toContain("Earlier answer of ses_other")
    pane.q("[data-control=new-chat]")!.click()
    await settle()
    expect(pane.q("[data-part=reply]")).toBeNull()

    expect(pane.word.doc.calls).toEqual([])
    expect(pane.reads).toEqual(["selection", "selection", "selection", "selection", "selection"])
  })
})

describe("U-UI-05 busy indicator and streaming (AC-15, D5b, D5c)", () => {
  test("busy in the same tick as Send; noise and the user echo change nothing; two deltas, two updates", async () => {
    const pane = await track(connected)
    pane.controller.setDraft("Summarise")
    await settle()
    pane.q("[data-control=send]")!.click()
    // Same tick: no await between the click and these checks.
    expect(pane.q("[data-part=waiting]")).not.toBeNull()
    expect(pane.q("[data-control=stop]")).not.toBeNull()
    expect(pane.marks).toEqual(["swarm.office.send", "swarm.office.busy"])
    await pane.bridge.streamOpened
    pane.bridge.push(frames.connected)
    await settle()

    const before = text(pane, "[data-part=thread]")
    for (const frame of frames.noise(SES)) pane.bridge.push(frame)
    pane.bridge.push(frames.message(SES, "msg_u", "user"))
    pane.bridge.push(frames.part(SES, "msg_u", "prt_u", "text"))
    pane.bridge.push(frames.delta(SES, "msg_u", "prt_u", "echo of the prompt"))
    pane.bridge.push(frames.message(SES, "msg_a", "assistant", { providerID: "gsp-ai-tail", modelID: "thinker" }))
    pane.bridge.push(frames.part(SES, "msg_a", "prt_r", "reasoning"))
    pane.bridge.push(frames.delta(SES, "msg_a", "prt_r", "thinking aloud"))
    await settle()
    expect(text(pane, "[data-part=thread]")).toBe(before)
    expect(pane.q("[data-part=waiting]")).not.toBeNull()

    const seen: string[] = []
    pane.bridge.push(frames.part(SES, "msg_a", "prt_a", "text"))
    pane.bridge.push(frames.delta(SES, "msg_a", "prt_a", "Hel"))
    await settle()
    seen.push(text(pane, "[data-part=reply-text]"))
    pane.bridge.push(frames.delta(SES, "msg_a", "prt_a", "lo"))
    await settle()
    seen.push(text(pane, "[data-part=reply-text]"))
    expect(seen).toEqual(["Hel", "Hello"])
    // Still streaming: caret, aria-busy, no provider line, no actions yet.
    expect(pane.q("[data-part=reply] .caret")).not.toBeNull()
    expect(pane.q("[data-part=reply]")!.getAttribute("aria-busy")).toBe("true")
    expect(pane.q("[data-part=provider]")).toBeNull()
    expect(pane.q("[data-control=copy]")).toBeNull()

    pane.bridge.push(frames.idle(SES))
    await settle()
    expect(pane.q("[data-part=reply] .caret")).toBeNull()
    expect(text(pane, "[data-part=thread]")).not.toContain("echo of the prompt")
    expect(text(pane, "[data-part=thread]")).not.toContain("thinking aloud")
  })
})

describe("U-UI-06 Stop and session.error (AC-16, FR-39, FR-42)", () => {
  test("Stop issues P7 abort and keeps the partial text", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, { text: "Partial", idle: false })
    await settle()
    pane.q("[data-control=stop]")!.click()
    await settle()
    const abort = pane.bridge.requests.filter((r) => r.path === `/swarm/session/${SES}/abort`)
    expect(abort.map((r) => r.method)).toEqual(["POST"])
    expect(text(pane, "[data-part=reply-text]")).toBe("Partial")
    expect(pane.q("[data-control=send]")).not.toBeNull()
  })

  test("session.error keeps the text and shows office.error.generic", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, { text: "Half an answer", idle: false })
    pane.bridge.push(frames.error(SES))
    await settle()
    expect(text(pane, "[data-part=reply-text]")).toBe("Half an answer")
    expect(pane.q("[data-part=toast]")!.getAttribute("role")).toBe("alert")
    expect(text(pane, "[data-part=toast]")).toContain("Something went wrong. Try again.")
    expect(pane.q("[data-control=send]")).not.toBeNull()
  })
})

describe("U-UI-09 / U-UI-15 context control (FR-22, AC-24, AC-50)", () => {
  test("radiogroup, labels per host, arrow keys, one tab stop, notice, persisted across a remount", async () => {
    const storage = memoryStore()
    const pane = await track({ ...connected, storage })
    const group = pane.q("[data-control=context]")!
    expect(group.getAttribute("role")).toBe("radiogroup")
    expect(group.getAttribute("aria-label")).toBe("Context to send")
    expect(pane.qa("[role=radio]").map((el) => el.textContent)).toEqual(["Selection", "Whole document"])
    expect(pane.qa("[role=radio]").map((el) => el.getAttribute("tabindex"))).toEqual(["0", "-1"])
    expect(text(pane, ".notice")).toBe("Sent to Swarm and to its model provider.")

    key(pane.q("[data-scope=selection]")!, { key: "ArrowRight" })
    await settle()
    expect(pane.q("[data-scope=whole]")!.getAttribute("aria-checked")).toBe("true")
    expect(pane.qa("[role=radio]").map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0"])
    expect(document.activeElement).toBe(pane.q("[data-scope=whole]"))
    expect(storage.getItem("swarm.office.contextScope")).toBe("whole")

    pane.unmount()
    open.splice(open.indexOf(pane), 1)
    const again = await track({ ...connected, storage })
    expect(again.q("[data-scope=whole]")!.getAttribute("aria-checked")).toBe("true")
    expect(text(again, ".notice")).toBe("Sent to Swarm and to its model provider.")
    key(again.q("[data-scope=whole]")!, { key: "ArrowLeft" })
    await settle()
    expect(storage.getItem("swarm.office.contextScope")).toBe("selection")

    const excel = await track({ ...connected, host: "Excel" })
    expect(excel.qa("[role=radio]").map((el) => el.textContent)).toEqual(["Selection", "Used range"])
  })
})

describe("U-UI-13 chat bar (FR-56, FR-33..FR-35, AC-48)", () => {
  test("absent outside connected", async () => {
    const pane = await track()
    expect(pane.controller.conn().name).toBe("unpaired")
    expect(pane.q("[data-part=chat-bar]")).toBeNull()
  })

  test("current title first, then at most 20 chats of this host newest first; pick loads 50; New chat", async () => {
    const word = Array.from({ length: 24 }, (_, at) => summary(`ses_w${at}`, `Word ${at}`, 100 + at))
    const other = [summary("ses_x1", "Excel chat", 999, "Excel")]
    const pane = await track({ ...connected, bridge: { handler: chats([...other, ...word]) } })
    expect(options(pane)[0]).toBe("New chat")
    await send(pane, "Summarise this")
    reply(pane, { text: "Done" })
    await settle()
    const list = pane.bridge.requests.filter((r) => r.method === "GET" && r.path === "/swarm/session")
    expect(list.at(-1)!.query.limit).toBe("20")
    const shown = options(pane)
    expect(shown[0]).toBe("Summarise this")
    expect(shown.slice(1)).toEqual(Array.from({ length: 20 }, (_, at) => `Word ${23 - at}`))
    expect(shown).not.toContain("Excel chat")

    await pick(pane, "ses_w7")
    const history50 = pane.bridge.requests.filter((r) => r.path === "/swarm/session/ses_w7/message")
    expect(history50.map((r) => r.query.limit)).toEqual(["50"])
    expect(options(pane)[0]).toBe("Word 7")
    expect(text(pane, "[data-part=thread]")).toContain("Earlier answer of ses_w7")
    expect(pane.storage.getItem(OFFICE_SESSION_STORAGE_PREFIX + (await docKey(URL_)))).toBe("ses_w7")

    // New chat is disabled while streaming.
    await send(pane, "More", false)
    const plus = pane.q("[data-control=new-chat]")!
    expect(plus.getAttribute("aria-disabled")).toBe("true")
    plus.click()
    await settle()
    expect(text(pane, "[data-part=thread]")).toContain("More")
    reply(pane, { session: "ses_w7", id: "msg_more", text: "More done" })
    await settle()
    expect(plus.getAttribute("aria-disabled")).toBeNull()

    plus.click()
    await settle()
    expect(pane.q("[data-part=user-turn]")).toBeNull()
    expect(pane.q(".empty")).not.toBeNull()
    expect(options(pane)[0]).toBe("New chat")
    expect(pane.storage.getItem(OFFICE_SESSION_STORAGE_PREFIX + (await docKey(URL_)))).toBeNull()
  })
})

describe("U-UI-14 Copy (FR-57, AC-49)", () => {
  test("writes exactly the reply text; Copied for 2 s; disabled on empty; enabled while busy and read-only", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, { text: "Line one\nLine two  " })
    await settle()
    const copy = pane.q("[data-control=copy]")!
    expect(copy.textContent).toBe("Copy")
    copy.click()
    await settle()
    expect(pane.copied).toEqual(["Line one\nLine two  "])
    expect(copy.textContent).toBe("Copied")
    pane.clock.flushTimeouts()
    await settle()
    expect(copy.textContent).toBe("Copy")

    // While the next reply streams: the finished reply keeps an enabled Copy; the streaming one has none.
    await send(pane, "y", false)
    reply(pane, { id: "msg_b", text: "Streaming", idle: false })
    await settle()
    const copies = pane.qa("[data-control=copy]")
    expect(copies.length).toBe(1)
    expect(copies[0]!.getAttribute("aria-disabled")).toBeNull()
    expect(pane.qa("[data-control=insert]")[0]!.getAttribute("aria-disabled")).toBe("true")
    expect(pane.word.doc.calls).toEqual([])
  })

  test("M8-02b Copy uses the write text: leading empty lines dropped, trailing breaks removed", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, { text: "\n\nBRAVO LINE TWO.\n" })
    await settle()
    pane.q("[data-control=copy]")!.click()
    await settle()
    expect(pane.copied).toEqual(["BRAVO LINE TWO."])
  })

  test("an empty reply has Copy disabled; a refused clipboard keeps the Copy label", async () => {
    const storage = memoryStore()
    await storedSession(storage, "ses_e")
    const pane = await track({
      ...connected,
      storage,
      clipboard: async () => false,
      bridge: {
        handler: (r) =>
          r.path === "/swarm/session/ses_e/message"
            ? {
                status: 200,
                body: [
                  { info: { id: "a0", role: "assistant", sessionID: "ses_e" }, parts: [] },
                  { info: { id: "a1", role: "assistant", sessionID: "ses_e" }, parts: [{ type: "text", text: "Hi" }] },
                ],
              }
            : undefined,
      },
    })
    const [empty, full] = pane.qa("[data-control=copy]")
    expect(empty!.getAttribute("aria-disabled")).toBe("true")
    full!.click()
    await settle()
    expect(full!.textContent).toBe("Copy")
    expect(pane.errors).toContain("copy")
  })

  test("navigator.clipboard.writeText rejects: execCommand('copy') on a hidden textarea is used", async () => {
    const commands: { command: string; value: string }[] = []
    const env = {
      clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
      document: {
        createElement: document.createElement.bind(document),
        body: document.body,
        execCommand: (command: string) => {
          commands.push({ command, value: document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value ?? "" })
          return true
        },
      },
    }
    expect(await copyText(env, "Reply text")).toBe(true)
    expect(commands).toEqual([{ command: "copy", value: "Reply text" }])
    expect(document.querySelector("textarea[readonly]")).toBeNull()
    const ok = { clipboard: { writeText: () => Promise.resolve() }, document: env.document }
    expect(await copyText(ok, "Other")).toBe(true)
    expect(commands.length).toBe(1)
  })
})

describe("U-UI-16 sent-turn tag (FR-58, AC-51, U12 Q1)", () => {
  test("selection changes before Send read nothing; the tag carries the size actually sent", async () => {
    const pane = await track(connected)
    pane.word.doc.selection = "One\r"
    pane.word.doc.selection = "Two words\r"
    pane.word.doc.selection = "Third, final selection\r"
    await settle()
    expect(pane.reads).toEqual([])
    expect(pane.q("[data-control=context]")!.textContent).not.toMatch(/\d/)

    await send(pane, "x")
    const sent = prompts(pane).at(-1)!.body as { parts: { text: string }[] }
    const context = sent.parts[0]!.text.replace(/^\[Office context: Word selection\]\n/, "")
    expect(context).toBe("Third, final selection\n")
    expect(text(pane, "[data-part=user-turn] .tag")).toBe(`Selection · ${context.length} characters`)
    expect(pane.reads).toEqual(["selection"])
  })

  test("whole document and an empty selection", async () => {
    const pane = await track({ ...connected, word: { selection: "", body: "Body text" } })
    await send(pane, "x")
    expect(text(pane, "[data-part=user-turn] .tag")).toBe("No context")
    expect((prompts(pane).at(-1)!.body as { parts: unknown[] }).parts.length).toBe(1)
    reply(pane, { text: "ok" })
    await settle()
    pane.q("[data-scope=whole]")!.click()
    await send(pane, "y", false)
    expect(pane.qa("[data-part=user-turn] .tag").at(-1)!.textContent).toBe("Whole document · 9 characters")
  })
})

describe("U-UI-17 provider line (FR-59, AC-52)", () => {
  test("nothing before message.updated names the provider; internal muted; external warning; no provider route", async () => {
    const pane = await track(connected)
    await send(pane, "x")
    reply(pane, { text: "First", extra: {} })
    await settle()
    expect(pane.q("[data-part=provider]")).toBeNull()
    pane.bridge.push(frames.message(SES, "msg_a", "assistant", { providerID: "gsp-ai-tail", modelID: "thinker" }))
    await settle()
    const internal = pane.q("[data-part=provider]")!
    expect(internal.getAttribute("data-provider")).toBe("internal")
    expect(internal.textContent).toBe("GSP-AI (internal) · thinker")
    expect(internal.classList.contains("ext")).toBe(false)

    await send(pane, "y", false)
    reply(pane, { id: "msg_b", text: "Second", extra: { providerID: "openai", modelID: "gpt-x" } })
    await settle()
    const external = pane.qa("[data-part=provider]").at(-1)!
    expect(external.getAttribute("data-provider")).toBe("external")
    expect(external.classList.contains("ext")).toBe(true)
    expect(external.getAttribute("role")).toBe("note")
    expect(external.textContent).toBe("External provider: openai · gpt-x. Content left GSP infrastructure and may be billed.")
    expect(pane.bridge.requests.filter((r) => /provider|config|model/.test(r.path))).toEqual([])
  })
})

describe("U-UI-20 keyboard (FR-61, AC-55)", () => {
  test("Enter, Shift+Enter, IME, blank; Esc stops while streaming; nothing written", async () => {
    const pane = await track(connected)
    const field = pane.q<HTMLTextAreaElement>("[data-control=prompt]")!
    pane.controller.setDraft("   ")
    key(field, { key: "Enter" })
    pane.controller.setDraft("Line")
    const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })
    field.dispatchEvent(shift)
    expect(shift.defaultPrevented).toBe(false)
    key(field, { key: "Enter", isComposing: true })
    await settle()
    expect(pane.marks).toEqual([])
    expect(pane.q("[data-part=user-turn]")).toBeNull()

    key(field, { key: "Enter" })
    await pane.bridge.streamOpened
    pane.bridge.push(frames.connected)
    await settle()
    expect(prompts(pane).length).toBe(1)
    reply(pane, { text: "Partial", idle: false })
    await settle()
    key(pane.q("[data-control=prompt]")!, { key: "Escape" })
    await settle()
    expect(pane.bridge.requests.filter((r) => r.path.endsWith("/abort")).length).toBe(1)
    expect(text(pane, ".rtag")).toBe("Stopped")
    expect(pane.word.doc.calls).toEqual([])
  })

  test("Esc in an open preview cancels it and puts focus back on the opener", async () => {
    const pane = await track({
      ...connected,
      // A stand-in for the M8-07 block: one focusable control inside the slot.
      preview: (input) => {
        const button = document.createElement("button")
        button.type = "button"
        button.dataset.test = "pv-cancel"
        button.textContent = "cancel"
        button.addEventListener("click", input.close)
        return button
      },
    })
    await send(pane, "x")
    reply(pane, { text: "Answer" })
    await settle()
    const insert = pane.q("[data-control=insert]")!
    insert.click()
    await settle()
    const inner = pane.q("[data-test=pv-cancel]")!
    inner.focus()
    key(inner, { key: "Escape" })
    await settle()
    expect(pane.q("[data-slot=preview]")).toBeNull()
    expect(document.activeElement).toBe(insert)

    pane.q("[data-control=replace]")!.click()
    await settle()
    pane.q("[data-test=pv-cancel]")!.click()
    await settle()
    expect(pane.q("[data-slot=preview]")).toBeNull()
    expect(document.activeElement).toBe(pane.q("[data-control=replace]"))
    expect(pane.word.doc.calls).toEqual([])
  })
})

describe("U-UI-24 reply tags (FR-64, AC-58)", () => {
  test("waiting text in the same tick; Stopped keeps the text", async () => {
    const pane = await track(connected)
    pane.controller.setDraft("Hello")
    void pane.controller.send()
    expect(text(pane, "[data-part=waiting]")).toBe("Thinking")
    await pane.bridge.streamOpened
    pane.bridge.push(frames.connected)
    await settle()
    reply(pane, { text: "Some", idle: false })
    await settle()
    await pane.controller.stop()
    await settle()
    expect(text(pane, "[data-part=reply-text]")).toBe("Some")
    expect(text(pane, ".rtag")).toBe("Stopped")
  })

  test("Stop before any text shows Stopped alone", async () => {
    const pane = await track(connected)
    await send(pane, "Hello")
    await pane.controller.stop()
    await settle()
    expect(pane.q("[data-part=waiting]")).toBeNull()
    expect(text(pane, ".rtag")).toBe("Stopped")
  })

  test("T16: the stream closes and the reconnect fails; the list stays with Interrupted", async () => {
    const pane = await track(connected)
    await send(pane, "Hello")
    reply(pane, { text: "Half", idle: false })
    await settle()
    pane.bridge.end()
    await settle()
    pane.bridge.end()
    await settle()
    expect(pane.controller.conn().name).toBe("unavailable")
    expect(pane.controls()).toEqual(["retry"])
    expect(text(pane, "[data-part=reply-text]")).toBe("Half")
    const tag = pane.q(".rtag")!
    expect(tag.textContent).toBe("Interrupted, connection lost")
    expect(tag.classList.contains("bad")).toBe(true)
  })

  test("session.error keeps the text (FR-42)", async () => {
    const pane = await track(connected)
    await send(pane, "Hello")
    reply(pane, { text: "Kept", idle: false })
    pane.bridge.push(frames.error(SES))
    await settle()
    expect(text(pane, "[data-part=reply-text]")).toBe("Kept")
  })
})

describe("Send guard (FR-25, FR-26)", () => {
  test("blank or over 2 MiB disables Send; Enter over the limit shows tooLarge and sends nothing", async () => {
    const pane = await track(connected)
    const sendButton = () => pane.q("[data-control=send]")!
    expect(sendButton().getAttribute("aria-disabled")).toBe("true")
    pane.controller.setDraft(" \n ")
    await settle()
    expect(sendButton().getAttribute("aria-disabled")).toBe("true")
    pane.controller.setDraft("ok")
    await settle()
    expect(sendButton().getAttribute("aria-disabled")).toBeNull()

    const big = "a".repeat(OFFICE_BODY_LIMIT_BYTES)
    expect(draftTooLarge(big)).toBe(true)
    expect(draftTooLarge("a".repeat(OFFICE_BODY_LIMIT_BYTES - 100))).toBe(false)
    pane.controller.setDraft(big)
    await settle()
    expect(sendButton().getAttribute("aria-disabled")).toBe("true")
    key(pane.q("[data-control=prompt]")!, { key: "Enter" })
    await settle()
    expect(text(pane, "[data-part=toast]")).toContain("larger than 2 MB")
    expect(prompts(pane)).toEqual([])
    expect(pane.marks).toEqual([])
    expect(pane.controller.draft()).toBe(big)
  })
})
