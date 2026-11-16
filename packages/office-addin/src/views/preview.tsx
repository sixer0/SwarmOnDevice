// Inline preview before every write (plan M8-07; FS §9.1 item 2, FR-47..FR-49, FR-63; design §6;
// C9 SC-43/SC-44, C12, C14, C15, C23). Rendered in the preview slot under the reply that asked
// (thread.tsx); it is inline, never a dialog (FR-43).
//
// Flow (design §6.1):
//   1. On open, one user-initiated read: the adapter's `preview` (FR-01). A read failure closes
//      the block with a toast.
//   2. The block shows the exact text, its counts and the target (Word), or the A1 target, size
//      and a mini grid with number alignment and kept-as-text markers (Excel). A refusal shows in
//      a danger strip and Write stays disabled.
//   3. Write calls the adapter `write` with the previewed `expected` target; the adapter re-reads
//      the selection (FR-49). A changed target shows the new plan with a warning strip and needs a
//      second click (SC-44). Otherwise it writes once, closes and toasts `office.reply.written`.
//   4. Cancel or Esc (handled by the slot wrapper) closes and returns focus to the opener.
//
// This file and the adapter are the only write path: no key, timer or server event reaches
// `confirm` (FR-47); only a click (or Enter/Space on the focused Write button) does.
import { For, Index, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { convertCell, replyToMatrix, type CellPlan, type Refusal } from "../excel"
import type { ExcelPlan, HostAdapter, HostFailure, RefusedTarget, WordPlan } from "../host/types"
import { useI18n, type MessageKey } from "../i18n"
import { writeText } from "../state/prompt"
import type { PaneController, PreviewRequest } from "./controller"
import type { PreviewSlot } from "./thread"

// Mini grid limits (design §6.3).
export const GRID_ROWS = 8
export const GRID_COLUMNS = 5
// Replace shows at most this many characters of the text that goes away (design §6.2).
export const REMOVED_CHARS = 120
// M8-07a (F-2): "Show all" renders the full grid up to this many cells; above it the full
// payload is shown as tab-separated text in a scrollable box instead.
export const GRID_ALL_CELLS = 2000

// M8-07a (F-3, TB-3): invisible and format characters in the text to be written: every Unicode
// Cf code point (zero-width U+200B-U+200D, U+2060, U+FEFF, bidi U+202A-U+202E and U+2066-U+2069,
// soft hyphen, ...) plus the tag block U+E0000-U+E007F (unassigned ones included). They render as
// nothing, so the preview shows each as a visible marker, counts them and asks for a second confirm.
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu
const INVISIBLE_SPLIT = /([\p{Cf}\u{E0000}-\u{E007F}])/u

export function invisibleCount(text: string) {
  return text.match(INVISIBLE)?.length ?? 0
}

export function markerOf(char: string) {
  return `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`
}

// Plain-string form, for `title` attributes.
export function visibleText(text: string) {
  return text.replace(INVISIBLE, markerOf)
}

// The text with every invisible character replaced by a styled marker (odd split indexes are the
// captured characters).
export function Visible(props: { text: string }) {
  return (
    <Index each={props.text.split(INVISIBLE_SPLIT)}>
      {(part, index) => (
        <Show when={index % 2 === 1} fallback={part()}>
          <span class="inv" data-part="invisible-mark">
            {markerOf(part())}
          </span>
        </Show>
      )}
    </Index>
  )
}

function InvisibleNote(props: { text: string; armed: boolean }) {
  const { t } = useI18n()
  // The register sentence (rev 6, C70), then the distinct code points, e.g. "⟨U+200B⟩ ⟨U+202E⟩".
  const marks = () => [...new Set(props.text.match(INVISIBLE) ?? [])].map(markerOf).join(" ")
  return (
    <div
      class="strip warn"
      classList={{ armed: props.armed }}
      role="alert"
      tabindex="-1"
      id={INVISIBLE_NOTE_ID}
      data-part="preview-invisible"
      data-count={invisibleCount(props.text)}
    >
      {t("office.preview.invisible", { count: invisibleCount(props.text) })}
      <span class="marks" data-part="invisible-list">
        {" "}
        {marks()}
      </span>
    </div>
  )
}

const INVISIBLE_NOTE_ID = "swarm-office-preview-invisible"

type Plan = WordPlan | ExcelPlan

export type PreviewView =
  | { phase: "reading" }
  | { phase: "plan"; plan: Plan; changed: boolean }
  | { phase: "refused"; refusal: Refusal; changed: boolean; target?: RefusedTarget }

const isFailure = (value: object): value is HostFailure => "code" in value && !("refusal" in value)

// ---------- Word ----------

export function wordTargetKey(plan: WordPlan): MessageKey {
  if (plan.selection === "") return "office.preview.targetCursor"
  if (plan.location === "Replace") return "office.preview.targetReplace"
  return "office.preview.targetAfter"
}

// Lines of the written text (H-1: one paragraph per line); 0 for an empty text.
export function paragraphCount(text: string) {
  if (text === "") return 0
  return text.split("\n").length
}

function WordBody(props: { plan: WordPlan; reply: string }) {
  const { t } = useI18n()
  // The exact text written, trailing line breaks removed (FR-04). The D6 paragraph break the
  // adapter appends after a whole paragraph is a separator, not content, so it is not shown.
  const text = () => writeText(props.reply)
  const removed = () => props.plan.selection.replace(/[\r\n]+$/, "").slice(0, REMOVED_CHARS)
  return (
    <>
      <dl class="kv">
        <dt>{t("office.preview.target")}</dt>
        <dd data-part="preview-target">{t(wordTargetKey(props.plan))}</dd>
      </dl>
      <Show when={props.plan.location === "Replace" && removed() !== ""}>
        <div>
          <div class="lab">{t("office.preview.removed")}</div>
          <div class="removed" data-part="preview-removed">
            {removed()}
          </div>
        </div>
      </Show>
      <div>
        <div class="lab">{t("office.preview.content")}</div>
        <div class="box mono" data-part="preview-text">
          <Visible text={text()} />
        </div>
        <div class="counts" data-part="preview-counts">
          {t("office.preview.chars", { count: text().length })} ·{" "}
          {t("office.preview.paragraphs", { count: paragraphCount(text()) })}
        </div>
      </div>
    </>
  )
}

// ---------- Excel ----------

export type GridInput = {
  cells: CellPlan[][]
  // Zero-based origin of the target; absent when the adapter refused before giving a target.
  rowIndex?: number
  columnIndex?: number
  // Relative position of a non-empty target cell (targetNotEmpty).
  busy?: { row: number; column: number }
  // M8-07a (F-2): the whole matrix is shown; `onShowAll` turns the "more" line into a button.
  all?: boolean
  onShowAll?: () => void
}

export function exceedsGrid(cells: CellPlan[][]) {
  return cells.length > GRID_ROWS || cells.some((row) => row.length > GRID_COLUMNS)
}

function columnLetters(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index)
  return columnLetters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26))
}

const cellText = (cell: CellPlan) => (cell.kind === "number" ? String(cell.value) : cell.value)
const keptAsText = (cell: CellPlan) => cell.kind === "text" && cell.formulaLeading

export function formulaAsTextCount(cells: CellPlan[][]) {
  return cells.flat().filter(keptAsText).length
}

export function Grid(props: GridInput) {
  const { t } = useI18n()
  const width = () => Math.max(0, ...props.cells.map((row) => row.length))
  const total = () => props.cells.reduce((sum, row) => sum + row.length, 0)
  // Above GRID_ALL_CELLS the full payload is text, so the table keeps the 8 x 5 window.
  const table = () => props.all === true && total() <= GRID_ALL_CELLS
  const asText = () => props.all === true && !table()
  const rows = () => (table() ? props.cells : props.cells.slice(0, GRID_ROWS).map((row) => row.slice(0, GRID_COLUMNS)))
  const shown = () => (table() ? width() : Math.min(width(), GRID_COLUMNS))
  const placed = () => props.rowIndex !== undefined && props.columnIndex !== undefined
  const moreRows = () => Math.max(0, props.cells.length - GRID_ROWS)
  const moreColumns = () => Math.max(0, width() - GRID_COLUMNS)
  return (
    <div data-part="preview-grid" data-all={props.all ? "true" : undefined}>
      <div classList={{ "grid-all": table() }}>
      <table class="grid" role="table">
        <Show when={placed()}>
          <thead>
            <tr>
              <th class="rh" />
              <For each={Array.from({ length: shown() }, (_, index) => index)}>
                {(index) => <th scope="col">{columnLetters((props.columnIndex ?? 0) + index)}</th>}
              </For>
            </tr>
          </thead>
        </Show>
        <tbody>
          <For each={rows()}>
            {(row, r) => (
              <tr>
                <Show when={placed()}>
                  <th class="rh" scope="row">
                    {(props.rowIndex ?? 0) + r() + 1}
                  </th>
                </Show>
                <For each={row}>
                  {(cell, c) => (
                    <td
                      classList={{
                        num: cell.kind === "number",
                        fx: keptAsText(cell),
                        full: props.busy?.row === r() && props.busy?.column === c(),
                      }}
                      title={visibleText(cellText(cell))}
                      data-kind={keptAsText(cell) ? "kept-as-text" : cell.kind}
                    >
                      <Visible text={cellText(cell)} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      </div>
      <Show when={asText()}>
        <div class="lab">{t("office.preview.fullText")}</div>
        <div class="box mono" data-part="preview-all-text">
          <Visible text={props.cells.map((row) => row.map(cellText).join("\t")).join("\n")} />
        </div>
      </Show>
      <Show when={!props.all && (moreRows() > 0 || moreColumns() > 0)}>
        <Show
          when={props.onShowAll}
          fallback={
            <div class="counts" data-part="preview-more">
              {t("office.preview.more", { rows: moreRows(), cols: moreColumns() })}
            </div>
          }
        >
          {(show) => (
            <div class="counts" data-part="preview-more">
              {t("office.preview.more", { rows: moreRows(), cols: moreColumns() })}{" "}
              <button class="btn sm neutral" type="button" data-control="show-all" onClick={() => show()()}>
                {t("office.preview.showAll")}
              </button>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function FormulaNote(props: { cells: CellPlan[][] }) {
  const { t } = useI18n()
  return (
    <Show when={formulaAsTextCount(props.cells) > 0}>
      <div class="strip warn" data-part="preview-formula">
        {t("office.preview.formulaAsText", { count: formulaAsTextCount(props.cells) })}
      </div>
      <div class="legend">
        <span>
          <i aria-hidden="true" />
          {t("office.preview.legendText")}
        </span>
        <span>{t("office.preview.legendNumber")}</span>
      </div>
    </Show>
  )
}

const cellsPart = (address: string) => address.slice(address.lastIndexOf("!") + 1)

function ExcelBody(props: { plan: ExcelPlan; all: boolean; onShowAll: () => void }) {
  const { t } = useI18n()
  const target = () => props.plan.plan.target
  return (
    <>
      <dl class="kv">
        <dt>{t("office.preview.target")}</dt>
        <dd data-part="preview-target">
          {t("office.preview.targetCells", { address: cellsPart(props.plan.target) })} ·{" "}
          {t("office.preview.size", { rows: target().rows, cols: target().columns })}
        </dd>
      </dl>
      <Grid
        cells={props.plan.plan.cells}
        rowIndex={target().rowIndex}
        columnIndex={target().columnIndex}
        all={props.all}
        onShowAll={props.onShowAll}
      />
      <FormulaNote cells={props.plan.plan.cells} />
    </>
  )
}

// A refused Excel write: the adapter names the cells it is about (M8-03b, C59). The target line
// shows them as in mockup S13 ("Cells B10:D12 · 3 x 3 cells") and the grid of the reply's cells
// carries their row and column headers, with the non-empty cell marked (targetNotEmpty). Without
// a target (older adapter) the size of the reply is shown and the grid has no headers.
function RefusedExcelBody(props: {
  reply: string
  refusal: Refusal
  target?: RefusedTarget
  all: boolean
  onShowAll: () => void
}) {
  const { t } = useI18n()
  const matrix = () => replyToMatrix(props.reply)
  const cells = () => matrix().rows.map((row) => row.map(convertCell))
  const busy = () =>
    props.refusal.code === "office.error.targetNotEmpty"
      ? { row: props.refusal.row, column: props.refusal.column }
      : undefined
  return (
    <>
      <dl class="kv">
        <dt>{t("office.preview.target")}</dt>
        <Show
          when={props.target}
          fallback={<dd data-part="preview-target">{t("office.preview.size", { rows: matrix().m, cols: matrix().n })}</dd>}
        >
          {(target) => (
            <dd data-part="preview-target" data-address={target().address}>
              {t("office.preview.targetCells", { address: cellsPart(target().address) })} ·{" "}
              {t("office.preview.size", { rows: target().rows, cols: target().columns })}
            </dd>
          )}
        </Show>
      </dl>
      <Grid
        cells={cells()}
        busy={busy()}
        rowIndex={props.target?.rowIndex}
        columnIndex={props.target?.columnIndex}
        all={props.all}
        onShowAll={props.onShowAll}
      />
      <FormulaNote cells={cells()} />
    </>
  )
}

function RefusalStrip(props: { refusal: Refusal }) {
  const { t } = useI18n()
  const text = () => {
    const refusal = props.refusal
    if (refusal.code === "office.error.shapeMismatch") return t(refusal.code, refusal.params)
    return t(refusal.code)
  }
  return (
    <div class="strip bad" role="alert" data-part="preview-refusal" data-code={props.refusal.code}>
      {text()}
    </div>
  )
}

// ---------- block ----------

type WritePort = PaneController["writePort"]

async function writePlan(adapter: HostAdapter, request: PreviewRequest, plan: Plan) {
  if (adapter.host === "Word") return adapter.write(request.action, request.text, plan.host === "Word" ? plan : undefined)
  return adapter.write(request.action, request.text, plan.host === "Excel" ? plan.target : undefined)
}

export function PreviewBlock(props: {
  request: PreviewRequest
  close: () => void
  port: WritePort
  writing: () => boolean
  // Streaming or read-only: Write stays disabled (FR-48, FR-60).
  blocked: () => boolean
}) {
  const { t } = useI18n()
  const [view, setView] = createSignal<PreviewView>({ phase: "reading" })
  const heading = { el: undefined as HTMLHeadingElement | undefined }
  // F-2: cells beyond the 8 x 5 window must be shown ("Show all") before Write is enabled.
  const [all, setAll] = createSignal(false)
  // F-3: with invisible characters the first Write click only arms; the second writes.
  const [armed, setArmed] = createSignal(false)
  const invisible = () => invisibleCount(props.request.text)
  // M8-03d: the Word plan whose tracked anchor this block still holds. A plan handed to `write`
  // is consumed there (released on every path), so it is cleared before the call; whatever is
  // still held when the block goes away (Cancel, Esc, another preview, a new Send) is released
  // exactly once.
  const anchor = { held: undefined as WordPlan | undefined, closed: false }
  const hold = (plan: Plan | undefined) => {
    anchor.held = plan?.host === "Word" ? plan : undefined
  }
  const releaseHeld = () => {
    const adapter = props.port.adapter()
    const held = anchor.held
    anchor.held = undefined
    if (held && adapter?.host === "Word") void adapter.release(held)
  }
  onCleanup(() => {
    anchor.closed = true
    releaseHeld()
  })

  const reveal = () => {
    heading.el?.focus()
    heading.el?.scrollIntoView?.({ block: "nearest" })
  }

  const fail = (failure: HostFailure, source: string) => {
    props.port.report(source, failure.detail ?? failure.code)
    props.close()
    props.port.toast({ key: failure.code, tone: "error" })
  }

  onMount(async () => {
    const adapter = props.port.adapter()
    if (!adapter) return props.close()
    const result = await adapter.preview(props.request.action, props.request.text)
    if (isFailure(result)) return fail(result, "preview")
    // Closed while the read ran: nothing will show this plan, so its anchor goes at once.
    if (result.ok) hold(result)
    if (anchor.closed) return releaseHeld()
    if (!result.ok) setView({ phase: "refused", refusal: result.refusal, changed: false, target: result.target })
    if (result.ok) setView({ phase: "plan", plan: result, changed: false })
    reveal()
  })

  const hidden = () => {
    const current = view()
    return current.phase === "plan" && current.plan.host === "Excel" && exceedsGrid(current.plan.plan.cells)
  }
  const canWrite = () => view().phase === "plan" && (!hidden() || all()) && !props.writing() && !props.blocked()

  async function confirm() {
    const current = view()
    const adapter = props.port.adapter()
    if (current.phase !== "plan" || !adapter || props.blocked()) return
    if (invisible() > 0 && !armed()) {
      setArmed(true)
      document.getElementById(INVISIBLE_NOTE_ID)?.focus()
      return
    }
    // FR-48: one confirm writes once; a second click while this runs is refused here.
    if (!props.port.begin()) return
    hold(undefined)
    const result = await writePlan(adapter, props.request, current.plan).finally(() => props.port.end())
    if ("changed" in result) {
      // FR-49 / SC-44: the selection moved. Show the new target; nothing was written.
      const next = result.plan
      if (next.ok) hold(next)
      if (anchor.closed) return releaseHeld()
      if (next.ok) setView({ phase: "plan", plan: next, changed: true })
      if (!next.ok) setView({ phase: "refused", refusal: next.refusal, changed: true, target: next.target })
      reveal()
      return
    }
    if (isFailure(result)) return fail(result, "write")
    if (!result.ok) {
      setView({ phase: "refused", refusal: result.refusal, changed: false, target: result.target })
      reveal()
      return
    }
    const target =
      result.host === "Word" ? t(wordTargetKey(result.plan)) : (result.plan.target.address ?? "")
    props.close()
    props.port.toast({ key: "office.reply.written", params: { target }, tone: "success" })
    props.port.announce("office.reply.written", { target })
  }

  const actionKey = (): MessageKey => (props.request.action === "insert" ? "office.reply.insert" : "office.reply.replace")
  const changed = () => {
    const current = view()
    return current.phase !== "reading" && current.changed
  }
  const refused = () => {
    const current = view()
    return current.phase === "refused" ? current : undefined
  }
  const wordPlan = () => {
    const current = view()
    return current.phase === "plan" && current.plan.host === "Word" ? current.plan : undefined
  }
  const excelPlan = () => {
    const current = view()
    return current.phase === "plan" && current.plan.host === "Excel" ? current.plan : undefined
  }

  return (
    <div class="pv" role="region" aria-label={t("office.reply.preview", { action: t(actionKey()) })} data-part="preview">
      <h4 tabindex="-1" ref={(el) => (heading.el = el)}>
        {t("office.reply.preview", { action: t(actionKey()) })}
      </h4>
      <Show when={changed()}>
        <div class="strip warn" role="alert" data-part="preview-changed">
          {t("office.preview.targetChanged")}
        </div>
      </Show>
      <Show when={view().phase !== "reading" && invisible() > 0}>
        <InvisibleNote text={props.request.text} armed={armed()} />
      </Show>
      <Switch>
        <Match when={view().phase === "reading"}>
          <div class="counts" aria-busy="true" data-part="preview-reading" />
        </Match>
        <Match when={refused()}>
          {(shown) => (
            <>
              <RefusalStrip refusal={shown().refusal} />
              <Show when={props.port.adapter()?.host === "Excel"}>
                <RefusedExcelBody
                  reply={props.request.text}
                  refusal={shown().refusal}
                  target={shown().target}
                  all={all()}
                  onShowAll={() => setAll(true)}
                />
              </Show>
            </>
          )}
        </Match>
        <Match when={wordPlan()}>
          {(plan) => <WordBody plan={plan()} reply={props.request.text} />}
        </Match>
        <Match when={excelPlan()}>
          {(plan) => <ExcelBody plan={plan()} all={all()} onShowAll={() => setAll(true)} />}
        </Match>
      </Switch>
      <div class="row">
        <button
          class="btn sm primary"
          type="button"
          data-control="write"
          aria-disabled={canWrite() ? undefined : "true"}
          aria-describedby={invisible() > 0 && view().phase !== "reading" ? INVISIBLE_NOTE_ID : undefined}
          data-confirm={armed() ? "again" : undefined}
          onClick={() => {
            if (!canWrite()) return
            void confirm()
          }}
        >
          {t("office.reply.confirm")}
        </button>
        <button class="btn sm neutral" type="button" data-control="cancel" onClick={() => props.close()}>
          {t("office.reply.cancel")}
        </button>
      </div>
    </div>
  )
}

// The App's preview slot for a controller (wired in app.tsx).
export function previewSlot(pane: PaneController): PreviewSlot {
  return (input) => (
    <PreviewBlock
      request={input.request}
      close={input.close}
      port={pane.writePort}
      writing={pane.writing}
      blocked={() => pane.busy() || pane.readOnly()}
    />
  )
}
