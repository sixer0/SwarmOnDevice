// Word executor (M8-03; FS §5 Word column, FR-01..FR-05, D6). Thin: each call is one
// Word.run batch that reads at action time, and uses WordApi 1.1 members only.
// This file and memory.ts are the only src files that call insertText (U-LINT-02).
import { OFFICE_CONTEXT_WHOLE } from "../constants"
import { writeText, type ContextScope } from "../state/prompt"
import { failWith, unsupported, type WordAnchor, type WordHost, type WordPlan, type WriteAction } from "./types"

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

// Value anchors (paragraphs, memory) compare by value; a tracked anchor needs Office
// (compareLocationWith) and never equals here.
export function sameAnchor(a: WordAnchor | undefined, b: WordAnchor | undefined) {
  if (!a || !b) return a === b
  if (a.kind === "paragraphs" && b.kind === "paragraphs") return a.start === b.start && a.end === b.end && a.count === b.count
  if (a.kind === "memory" && b.kind === "memory") return a.position === b.position
  return false
}

// M8-03c: queues what the location anchor of `selection` needs in this batch; the returned
// function builds the anchor after the next sync. WordApi 1.3: the Range itself, tracked so a
// later batch can compare it. Otherwise: first/last paragraph index by text (WordApi 1.1).
function anchorOf(context: Word.RequestContext, selection: Word.Range, tracked: boolean): () => WordAnchor {
  if (tracked) {
    selection.track()
    return () => ({ kind: "tracked", range: selection })
  }
  const own = selection.paragraphs
  const body = context.document.body.paragraphs
  own.load("items/text")
  body.load("items/text")
  return () => {
    const texts = body.items.map((paragraph) => paragraph.text)
    const start = texts.indexOf(own.items[0]?.text ?? "")
    const end = start < 0 ? -1 : texts.indexOf(own.items[own.items.length - 1]?.text ?? "", start)
    return { kind: "paragraphs", start, end, count: texts.length }
  }
}

// M8-03d: drop a tracked Range from the tracked-object list; value anchors hold nothing.
function releaseAnchor(anchor: WordAnchor | undefined): Promise<void> {
  if (anchor?.kind !== "tracked") return Promise.resolve()
  return Word.run(anchor.range, async (context) => {
    context.trackedObjects.remove(anchor.range)
    await context.sync()
  }).catch(() => undefined)
}

export function wordHost(): WordHost {
  const supported = () => Office.context.requirements.isSetSupported("WordApi", "1.1")
  const tracking = () => Office.context.requirements.isSetSupported("WordApi", "1.3")
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
        const anchor = anchorOf(context, selection, tracking())
        await context.sync()
        return { ...planWordWrite(action, reply, selection.text), anchor: anchor() }
      }).catch(failWith("office.error.readFailed"))
    },
    write: (action, reply, expected) => {
      if (!supported()) return Promise.resolve(unsupported)
      const anchor = expected?.anchor
      const batch = async (context: Word.RequestContext) => {
        const selection = context.document.getSelection()
        selection.load("text")
        // FR-49 / SC-44: the fresh selection must be at the previewed location, not only
        // carry the same text (a moved caret, a repeated heading).
        const relation = anchor?.kind === "tracked" ? selection.compareLocationWith(anchor.range) : undefined
        const position = anchor?.kind === "paragraphs" ? anchorOf(context, selection, false) : undefined
        await context.sync()
        const plan = planWordWrite(action, reply, selection.text)
        const moved =
          (relation !== undefined && relation.value !== "Equal") ||
          (position !== undefined && !sameAnchor(anchor, position()))
        if (anchor?.kind === "tracked") context.trackedObjects.remove(anchor.range)
        if (expected && (moved || !samePlan(plan, expected))) {
          // Nothing is written; the fresh plan carries a fresh anchor for the second confirm.
          if (anchor?.kind !== "tracked")
            return { ok: false as const, changed: true as const, plan: { ...plan, anchor: position?.() } }
          const next = anchorOf(context, selection, true)
          await context.sync()
          return { ok: false as const, changed: true as const, plan: { ...plan, anchor: next() } }
        }
        selection.insertText(plan.text, plan.location)
        await context.sync()
        return { ok: true as const, host: "Word" as const, plan }
      }
      const run = anchor?.kind === "tracked" ? Word.run(anchor.range, batch) : Word.run(batch)
      // A failed batch may stop before its own remove; release so `write` consumes the anchor on
      // every path (M8-03d). A second remove of an already released range is swallowed.
      return run.catch((error: unknown) => releaseAnchor(anchor).then(() => failWith("office.error.writeFailed")(error)))
    },
    release: (plan) => releaseAnchor(plan.anchor),
  }
}
