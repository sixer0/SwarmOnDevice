import { For, Show, createEffect, createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import {
  buildLaneControlModel,
  patchLaneControl,
  readLaneStatus,
  type LaneStatusClient,
  type LaneRead,
  type PatchOutcome,
} from "./lane-controls.model"

// Lane controls + monitoring read-out (row 248, blueprint 11). Mounted inside the Home status card as its own
// clearly-labelled block, captioned by the tilde source path so it stays separate from the four-level ladder and
// costs no i18n key — the exact zero-cost captioning row 203 used for the seven-component records block
// (home-status-card.tsx:79).
//
// i18n posture (row 248 dispatch item 6, amended by row 249 under the 2026-10-22 USER DECISIONS item 1): the
// gate-195 cap of six was exhausted at dispatch; the user then moved it six → seven and spent the single freed key
// on exactly ONE thing — the apply-consequence sentence `setup.lanes.apply_warning`, rendered persistently below.
// Until that decision, the consequence rode only on the persistent `container-recreate` token; the token stays as
// the technical restart-class value (R7), but the meaning no longer depends on reading it. Everything else this
// component paints remains either (a) a monospace technical token — env name, number, `[min,max]` range bracket,
// the literal field names `stored`/`observed`/`range`/`setupValue`/`restartRequired` exactly as they appear on the
// wire (the same R7 field-name-token class the sibling card already prints for `observedAt`/`receivedAt` at
// home-status-card.tsx:67,70), the closed observation vocabulary `observed`/`absent`/`unobserved:<reason>`, the
// restart class `container-recreate`, and refusal tokens like `LANE_VALUE_OUT_OF_RANGE` — or (b) the pre-existing
// key `common.loading`, used at its literal meaning for the in-flight line (row 203 reused it identically; it is
// translated in all 61 locales and adds nothing to the exemption list). The other six prose labels this control
// WOULD want (a human heading, "stored"/"applied" column captions, an "Apply" verb, per-control accessible names,
// the documented-not-effective disclosure, a refresh label) were DECLINED at prototype stage and stay unminted —
// see implementation/s6b_d5_card.md §8 and decisions/decisions.md 2026-10-22 item 1.
//
// POLLING COST (row 247 §10 item 7): each GET can exec up to five docker children when a daemon is present, so this
// block does NOT poll at health cadence. It reads once on mount and re-reads only after a user-initiated write.

export function LaneControls(props: { client: Accessor<LaneStatusClient | undefined> }) {
  const language = useLanguage()
  const [state, setState] = createStore<{
    read?: LaneRead
    loading: boolean
    drafts: Record<string, number>
    busyKey?: string
    outcome?: { key: string; result: PatchOutcome }
  }>({ loading: false, drafts: {} })

  // One-shot read on mount (and whenever the client identity appears). No interval — see the cost note above.
  createEffect(() => {
    const client = props.client()
    if (!client) return
    let cancelled = false
    setState("loading", true)
    void readLaneStatus(client).then((read) => {
      if (cancelled) return
      setState({ read, loading: false })
    })
    return () => {
      cancelled = true
    }
  })

  const model = createMemo(() => buildLaneControlModel(state.read))

  const draftFor = (key: string, fallback: number) => (key in state.drafts ? state.drafts[key] : fallback)

  const submit = async (key: string, value: number) => {
    const client = props.client()
    if (!client) return
    setState("busyKey", key)
    const result = await patchLaneControl(client, key, value)
    setState({ busyKey: undefined, outcome: { key, result } })
    // After a committed change, re-read once so `observed` refreshes honestly (still unobserved until a carrier
    // confirms it — the card never upgrades stored to applied on its own authority).
    if (result.kind === "applied") void readLaneStatus(client).then((read) => setState("read", read))
  }

  return (
    <section
      data-component="lane-controls"
      // Accessible name is the tilde source path (a technical token), not invented prose — mirrors the records
      // block's source-path captioning and respects the exhausted key cap.
      aria-label={model().filePath ?? "~/.swarm/setup/lanes.json"}
      class="flex min-w-0 flex-col gap-2 border-t border-v2-border-border-base pt-2"
    >
      {/* Caption = the file this surface reads, monospace data (R7), zero keys. */}
      <div class="font-mono text-[10px] text-v2-text-text-faint">{model().filePath ?? "~/.swarm/setup/lanes.json"}</div>

      {/* The apply consequence, stated in prose (the one key row 249 minted under the cap six→seven, decisions.md
          2026-10-22 item 1). Persistent, not write-triggered: a dial over a recreate knob must say so before the
          first Enter, not only after. The `container-recreate` token below keeps its technical meaning; it no
          longer carries this sentence alone. */}
      <div class="text-12-regular text-v2-text-text-faint" data-lane-apply-warning>
        {language.t("setup.lanes.apply_warning")}
      </div>

      <Show when={state.loading && !state.read}>
        <div class="text-12-regular text-v2-text-text-faint">{language.t("common.loading")}</div>
      </Show>

      {/* An unreadable/invalid lanes.json surfaces the verbatim error token, never a silent default (06 §4.1). */}
      <Show when={model().fileError}>
        <div class="max-w-full truncate font-mono text-[10px] text-v2-text-text-faint" title={model().fileError}>
          {model().fileError}
        </div>
      </Show>

      <For each={model().controls}>
        {(c) => {
          const outcome = () => (state.outcome?.key === c.key ? state.outcome!.result : undefined)
          const usable = () => !Number.isNaN(c.min) && !Number.isNaN(c.offeredValue)
          return (
            <div class="flex min-w-0 flex-col gap-1 rounded-[8px] bg-v2-background-bg-base px-2 py-1.5" data-control={c.key}>
              {/* Control name = the env/file key, monospace (R7). */}
              <div class="font-mono text-12-medium text-v2-text-text-base">{c.key}</div>
              <div class="font-mono text-[10px] text-v2-text-text-faint">
                {c.stack}/{c.service}
              </div>

              {/* The tuple, never collapsed: stored, range, setupValue, restart class, observed — each its own token. */}
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px] text-v2-text-text-muted">
                <span>
                  stored=
                  <Show when={c.stored.state === "present"} fallback={<span>{"absent"}</span>}>
                    <span class="text-v2-text-text-base">{c.stored.state === "present" ? c.stored.value : ""}</span>
                  </Show>
                </span>
                <Show when={!Number.isNaN(c.min)}>
                  <span>
                    range=[{c.min},{c.max}]
                  </span>
                </Show>
                <Show when={!Number.isNaN(c.setupValue)}>
                  <span>setupValue={c.setupValue}</span>
                </Show>
                {/* Restart class on the control's own face — no dial implies immediate effect over a recreate knob. */}
                <span>{c.restartClass}</span>
                {/* Observed kept distinct from stored; absence never renders as a value or false (work item 4). */}
                <span>
                  observed=
                  <Show when={c.observed.state === "observed"} fallback={<ObservedAbsence observed={c.observed} />}>
                    <span class="text-v2-text-text-base">{c.observed.state === "observed" ? c.observed.value : ""}</span>
                  </Show>
                </span>
              </div>

              {/* Write affordance using only technical tokens: a numeric input named by its key, submitted on Enter.
                  No "Apply" button label (that would be a minted prose key — routed to 249). Bounds mirror the range
                  so an out-of-range entry is caught client-side AND server-side; the server still refuses, never clamps. */}
              <Show when={usable()}>
                <input
                  type="number"
                  class="w-24 rounded border border-v2-border-border-base bg-transparent px-1 py-0.5 font-mono text-[11px]"
                  aria-label={c.key}
                  min={c.min}
                  max={c.max}
                  step={1}
                  value={draftFor(c.key, c.offeredValue)}
                  disabled={state.busyKey === c.key}
                  onInput={(e) => setState("drafts", c.key, Number(e.currentTarget.value))}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return
                    const value = draftFor(c.key, c.offeredValue)
                    if (Number.isInteger(value)) void submit(c.key, value)
                  }}
                />
              </Show>

              {/* Refusal surfaces the spec token + offending value/range verbatim — never a silent clamp (work item 5). */}
              <Show when={outcome()?.kind === "refused"}>
                <RefusalLine result={outcome()} />
              </Show>
              <Show when={outcome()?.kind === "failed"}>
                <div class="font-mono text-[10px] text-v2-text-text-faint">write=failed:{failCause(outcome())}</div>
              </Show>
              {/* Applied states the truth: stored changed and recreation is still required; it claims no live effect. */}
              <Show when={outcome()?.kind === "applied"}>
                <div class="font-mono text-[10px] text-v2-text-text-faint">write=applied:{c.restartClass}</div>
              </Show>
            </div>
          )
        }}
      </For>
    </section>
  )
}

// Absence arms render the route's own vocabulary: `absent` (carrier up, key missing) or `unobserved:<reason>`.
// Neither may collapse to a number or `false` (dispatch item 4).
function ObservedAbsence(props: { observed: ReturnType<typeof buildLaneControlModel>["controls"][number]["observed"] }) {
  return (
    <Show
      when={props.observed.state === "unobserved"}
      fallback={<span class="text-v2-text-text-base">{"absent"}</span>}
    >
      <span class="text-v2-text-text-base">
        {"unobserved"}:{props.observed.state === "unobserved" ? props.observed.reason : ""}
      </span>
    </Show>
  )
}

function RefusalLine(props: { result: PatchOutcome | undefined }) {
  const r = () => (props.result?.kind === "refused" ? props.result : undefined)
  return (
    <div class="font-mono text-[10px] text-v2-text-text-faint">
      <span>{r()?.token}</span>
      <Show when={r()?.value !== undefined}>
        <span>{" "}value={r()?.value}</span>
      </Show>
      <Show when={r()?.range}>
        <span>
          {" "}range=[{r()?.range?.min},{r()?.range?.max}]
        </span>
      </Show>
    </div>
  )
}

// Narrow the failure cause on a single reference so TypeScript keeps the discriminant (a double outcome() call
// would not narrow). Renders nothing but the closed transport-cause token — no prose, no clamp.
function failCause(o: PatchOutcome | undefined): string {
  return o && o.kind === "failed" ? o.cause : ""
}
