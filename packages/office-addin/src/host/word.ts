// Word executor (M8-03; FS §5 Word column, FR-01..FR-05, D6). Thin: each call is one
// Word.run batch that reads at action time, and uses WordApi 1.1 members only.
// This file and memory.ts are the only src files that call insertText (U-LINT-02).
import { OFFICE_CONTEXT_WHOLE } from "../constants"
import { writeText, type ContextScope } from "../state/prompt"
import { failWith, unsupported, type WordHost, type WordPlan, type WriteAction } from "./types"

// FR-04 / D6 (C22): Insert after a selection whose text ends with a paragraph mark
// appends one paragraph break, so the last inserted line does not merge into the next
// paragraph (SP-S3 F-S3-1). Replace and every other selection pass the text unchanged;
// Replace keeps the selected paragraph mark (SP-S3 W4: 6 -> 7 paragraphs for 2 lines).
// Pure, shared with the in-memory adapter.
export function planWordWrite(action: WriteAction, reply: string, selection: string): WordPlan {
  const text = writeText(reply)
  if (action === "replace") return { ok: true, host: "Word", action, location: "Replace", text, selection }
  return {
    ok: true,
    host: "Word",
    action,
    location: "After",
    text: selection.endsWith("\r") ? text + "\n" : text,
    selection,
  }
}

export function samePlan(a: WordPlan, b: WordPlan) {
  return a.action === b.action && a.location === b.location && a.text === b.text && a.selection === b.selection
}

export function wordHost(): WordHost {
  const supported = () => Office.context.requirements.isSetSupported("WordApi", "1.1")
  return {
    host: "Word",
    supported,
    read: (scope: ContextScope) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Word.run(async (context) => {
        const source = scope === OFFICE_CONTEXT_WHOLE ? context.document.body : context.document.getSelection()
        source.load("text")
        await context.sync()
        return { ok: true as const, host: "Word" as const, scope, text: source.text }
      }).catch(failWith("office.error.readFailed"))
    },
    preview: (action, reply) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Word.run(async (context) => {
        const selection = context.document.getSelection()
        selection.load("text")
        await context.sync()
        return planWordWrite(action, reply, selection.text)
      }).catch(failWith("office.error.readFailed"))
    },
    write: (action, reply, expected) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Word.run(async (context) => {
        const selection = context.document.getSelection()
        selection.load("text")
        await context.sync()
        const plan = planWordWrite(action, reply, selection.text)
        // FR-49: re-read at the confirm click; a moved selection needs a new confirm.
        if (expected && !samePlan(plan, expected)) return { ok: false as const, changed: true as const, plan }
        selection.insertText(plan.text, plan.location)
        await context.sync()
        return { ok: true as const, host: "Word" as const, plan }
      }).catch(failWith("office.error.writeFailed"))
    },
  }
}
