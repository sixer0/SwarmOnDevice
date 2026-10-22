import { For, Show, createMemo } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { createSetupStatus } from "@/context/setup-status"
import { buildStatusCardModel, type Cell, type Level3Input, type LadderRow } from "./home-status-card.model"

// Home status card (row 203). Renders four INDEPENDENT levels per surface, each labelled with its own source and
// freshness, and never collapses them into a verdict (masterplan/04_s6_status_spec.md §6 R1/R2/R3). All honesty
// decisions live in home-status-card.model.ts; this file only lays those decisions out, so a reviewer diffing
// layout cannot accidentally move a truthfulness rule.
//
// HOME-SPLIT DECISION (spec §8, dispatch item 2): mounted on BOTH NewHome (pages/home.tsx) and LegacyHome
// (pages/home/legacy-home.tsx), so neither layout is blind to it. newLayoutDesigns defaults true
// (context/settings.tsx:61), so NewHome is the common case; legacy is the exception but still gets the card.
//
// LEVEL 3 POSTURE (spec §6 R4, AC-192-8): the card does NOT fetch `/mcp` to fill itself, because the first read
// for a directory spawns every configured child (opencode/src/mcp/index.ts:598 -> :508-531). It renders level 3
// as `unknown / not_observed` unless the caller already holds a directory-scoped observation and passes it via
// the `mcp` prop. Populating level 3 is therefore an explicit, disclosed action owned by the caller, not a side
// effect of opening Home. The non-forcing "has this instance booted?" primitive R4 option (a) needs is not
// exposed today (mcp/index.ts:167-190), so option (b) is the only fully-honest default.

export function HomeStatusCard(props: { mcp?: Level3Input }) {
  const language = useLanguage()
  // The client is reached through Global/Server, not ServerSDK: ServerSDKProvider is mounted only on the
  // server-scoped session routes (app.tsx:123/170/217), NOT on either Home layout (NewHome sits under
  // SharedProviders at app.tsx:570-576, which has no SDK provider; LegacyHome's shell reaches data via Global too).
  // ensureServerCtx(conn).sdk.client is the same client server-sdk itself uses (server-sdk.tsx:398) and is
  // available wherever GlobalProvider + ServerProvider are — i.e. both Home surfaces.
  const global = useGlobal()
  const server = useServer()
  // Translated value words whose keys row 204 lands in en.ts/id.ts. Until then `t` returns the raw key (the E14
  // behaviour); the cast is the mechanical seam between "row 203 references these keys" and "row 204 defines them",
  // so this file never edits the locale tables (inventory s6_03_i18n_inventory.md §5 assigns en.ts/id.ts to 204).
  const tKey = language.t as (key: string, params?: Record<string, string | number | boolean>) => string

  const status = createSetupStatus(() => {
    const conn = server.current
    if (!conn) return undefined
    return global.ensureServerCtx(conn).sdk.client
  })
  const model = createMemo(() => buildStatusCardModel({ read: status.read, loading: status.loading, mcp: props.mcp }))

  return (
    <section
      data-component="home-status-card"
      // Own accessible name, NOT home.projects (R8): the sidebar <aside> is named "Projects"; this section is not.
      aria-label={language.t("status.popover.trigger")}
      class="flex min-w-0 flex-col gap-3 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3"
    >
      <div class="text-v2-text-text-muted [font-weight:530]">{language.t("status.popover.trigger")}</div>

      <Show when={status.loading && !status.read}>
        <div class="text-12-regular text-v2-text-text-faint">{language.t("common.loading")}</div>
      </Show>

      <div class="flex min-w-0 flex-col gap-2">
        <For each={model().ladder}>{(row) => <LadderSurface row={row} tKey={tKey} />}</For>
      </div>

      {/* Freshness, stated once for levels 1-2. observedAt (server read time) and receivedAt (client arrival) are
          printed as separate labelled tokens and never merged (spec §4 rule 1, R3). */}
      <Show when={model().freshness.observedAt || model().freshness.receivedAt}>
        <div class="flex flex-wrap gap-x-3 font-mono text-[10px] leading-tight text-v2-text-text-faint">
          <Show when={model().freshness.observedAt}>
            <span>observedAt {model().freshness.observedAt}</span>
          </Show>
          <Show when={model().freshness.receivedAt}>
            <span>receivedAt {new Date(model().freshness.receivedAt!).toISOString()}</span>
          </Show>
        </div>
      </Show>

      {/* The seven-component register list as its OWN block, captioned by its source path (R7 data, not copy) so it
          stays clearly separated from the ladder and costs no extra i18n key (R6). */}
      <Show when={model().records.length > 0}>
        <div class="flex min-w-0 flex-col gap-1 border-t border-v2-border-border-base pt-2">
          <div class="font-mono text-[10px] text-v2-text-text-faint">{model().stateFilePath ?? "~/.swarm/setup/state.json"}</div>
          <For each={model().records}>
            {(rec) => (
              <div class="flex items-center justify-between gap-2 text-12-regular">
                <span class="font-mono text-v2-text-text-muted">{rec.component}</span>
                <CellView cell={rec.cell} tKey={tKey} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

function LadderSurface(props: { row: LadderRow; tKey: (key: string) => string }) {
  const levels = () => [
    { labelKey: "setup.status.installed", cell: props.row.installed },
    { labelKey: "setup.status.registered", cell: props.row.registered },
    { labelKey: "setup.status.visible", cell: props.row.visible },
    { labelKey: "setup.status.used", cell: props.row.used },
  ]
  return (
    <div class="flex min-w-0 flex-col gap-1 rounded-[8px] bg-v2-background-bg-base px-2 py-1.5">
      <div class="font-mono text-12-medium text-v2-text-text-base">{props.row.surface}</div>
      <For each={levels()}>
        {(level) => (
          <div class="flex items-baseline justify-between gap-2" data-slot={`level-${level.labelKey}`}>
            <span class="text-12-regular text-v2-text-text-muted">{props.tKey(level.labelKey)}</span>
            <CellView cell={level.cell} tKey={props.tKey} />
          </div>
        )}
      </For>
    </div>
  )
}

function CellView(props: { cell: Cell; tKey: (key: string) => string }) {
  const value = () => {
    const cell = props.cell
    if (cell.labelKey) return props.tKey(cell.labelKey)
    return cell.token ?? ""
  }
  return (
    <span class="flex items-baseline gap-1.5 text-right" data-kind={props.cell.kind}>
      <span class="text-12-regular text-v2-text-text-base">{value()}</span>
      {/* Causes, details and sources are R7 monospace technical tokens, never translated or dressed up. */}
      <Show when={props.cell.causeToken}>
        <span class="font-mono text-[10px] text-v2-text-text-faint">{props.cell.causeToken}</span>
      </Show>
      <Show when={props.cell.detailToken}>
        <span class="max-w-[16rem] truncate font-mono text-[10px] text-v2-text-text-faint" title={props.cell.detailToken}>
          {props.cell.detailToken}
        </span>
      </Show>
      <Show when={props.cell.sourceToken}>
        <span class="font-mono text-[10px] text-v2-text-text-faint opacity-70">{props.cell.sourceToken}</span>
      </Show>
    </span>
  )
}
