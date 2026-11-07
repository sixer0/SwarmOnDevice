// HQ command deck (row 130; masterplan/01_specs_mission_control_ui.md §5.3, §6 items 5-19, 38, 41; decisions U20, C59).
// The visual of report/mission_control_master.html (v6): You + Swarm on the tiered deck, the hologram progress ring,
// the decision beacon, the lit phase rooms of the mission type with one role robot per row, status badges, lamp cones
// and conduits; a compact lanes layout below 540 px. Draws the row 129 model only (no re-derivation) and renders every
// mission string as a text node (§12). Geometry: mission-hq-scene.ts.

import { useLanguage } from "@/context/language"
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { MissionAgentStatus, MissionAgentVM, MissionFamily, MissionTool, MissionVM } from "./mission-model"
import {
  agentLabel,
  checkpointFill,
  cssVar as v,
  DELIVERABLE_COLOR,
  FAMILIES,
  familyColor,
  HQ_TOKENS,
  hqScene,
  STATUS_COLOR,
  STATUS_ORDER,
  type AgentSpot,
  type LanesScene,
  type RadialScene,
} from "./mission-hq-scene"

export type MissionHQProps = {
  mission: MissionVM
  /** Stage width in px. When absent the component measures its own width. */
  width?: number
  /** Selected row id (label drawn in full ink). */
  selected?: string
  onSelectAgent?: (rowId: string) => void
  onOpenDecision?: () => void
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

// Static CSS only (no mission text). Motion is off under prefers-reduced-motion (§6 item 41, V6:94).
const CSS = `
.hq-root{position:relative;width:100%;color:var(--hq-ink);background:radial-gradient(120% 90% at 50% 52%,var(--hq-stage-2),var(--hq-stage) 70%);border-radius:12px;overflow:hidden}
.hq-root svg{display:block;width:100%;height:auto}
.hq-agent,.hq-beacon{cursor:pointer;outline:none}
.hq-agent:focus-visible .hq-ring{stroke:var(--hq-glow);stroke-width:2}
.hq-beacon:focus-visible rect{stroke-width:2.4}
.hq-legend{position:absolute;left:12px;bottom:8px;display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--hq-ink-2);pointer-events:none}
.hq-legend span{display:inline-flex;align-items:center;gap:5px}.hq-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}
@keyframes hq-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}
@keyframes hq-flick{0%,100%{opacity:.85}50%{opacity:1}}
@keyframes hq-flow{to{stroke-dashoffset:-22}}
@keyframes hq-spin{to{transform:rotate(360deg)}}
@keyframes hq-ping{0%{r:6px;opacity:.9}100%{r:18px;opacity:0}}
.hq-running .hq-bob{animation:hq-bob 2.6s ease-in-out infinite}
.hq-running .hq-cone{animation:hq-flick 2.6s ease-in-out infinite}
.hq-flow{stroke-dasharray:2 9;animation:hq-flow 1.5s linear infinite}
.hq-orbit{transform-box:fill-box;transform-origin:center;animation:hq-spin 40s linear infinite}
.hq-ping{animation:hq-ping 1.6s ease-out infinite}
@media (prefers-reduced-motion:reduce){.hq-running .hq-bob,.hq-running .hq-cone,.hq-flow,.hq-orbit,.hq-ping{animation:none}}
`

const TOOL: Record<MissionTool, string> = {
  hub: "M0 -5 L4.3 -2.5 V2.5 L0 5 L-4.3 2.5 V-2.5 Z M-1.6 0 H1.6",
  code: "M-3 -3 L-6 0 L-3 3 M3 -3 L6 0 L3 3",
  lens: "M1.5 1.5 L5 5 M-1.5 -1.5 m-3.5 0 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0",
  chart: "M-4.5 5 V0 M0 5 V-4.5 M4.5 5 V2",
  shield: "M0 -5.5 L5 -3.5 V0.5 Q5 4 0 5.5 Q-5 4 -5 0.5 V-3.5 Z",
  check: "M-4 0 L-1.3 2.8 L4.2 -3",
  send: "M-5 1 L5 -4.5 L1.2 5 L0 1 Z",
  chat: "M-5 -4 H5 V2 H0 L-3 5 V2 H-5 Z",
  grid: "M-5 -5 H5 V5 H-5 Z M-5 0 H5 M0 -5 V5",
  pen: "M-4 4 L-3 1 L3 -5 L5 -3 L-1 3 Z",
  flask: "M-2 -5 H2 M-1.5 -5 V-1 L-5 5 H5 L1.5 -1 V-5",
}
const HELMET: Record<MissionFamily, string> = {
  plan: "M-21 -70 Q-21 -88 0 -88 Q21 -88 21 -70 Z",
  research: "M-24 -73 H24 Q22 -78 16 -80 H-16 Q-22 -78 -24 -73 Z M-16 -80 Q0 -94 16 -80 Z",
  build: "M-22 -71 Q-20 -92 0 -92 Q20 -92 22 -71 Z M-3 -94 H3 V-88 H-3 Z",
  verify: "M-21 -72 Q0 -86 21 -72 V-76 Q0 -92 -21 -76 Z",
  ship: "M-21 -74 H21 V-80 Q0 -90 -21 -80 Z",
}
const BADGE: Partial<Record<MissionAgentStatus, [string, string]>> = {
  issue: ["M0 -3.5 V1 M0 3.3 V3.4", "#fff"],
  blocked: ["M-2 -3 V3 M2 -3 V3", "#1b1200"],
  done: ["M-3 0 L-1 2.2 L3.2 -2.4", "#fff"],
}
const CONE: Partial<Record<MissionAgentStatus, string>> = { running: "coneRun", review: "coneReview", issue: "coneIssue" }

type Url = (name: string) => string

/** Role robot (V6:193-224): shell + family helmet + visor + role tool + status lamp, ring and badge. */
function Bot(props: {
  url: Url
  family: MissionFamily
  tool: MissionTool
  status: MissionAgentStatus
  x: number
  y: number
  s: number
  noLamp?: boolean
  color?: string
  halo?: boolean
}) {
  const F = () => v(props.color ?? familyColor(props.family))
  const c = () => v(STATUS_COLOR[props.status])
  const eye = () => (props.family === "verify" ? "#f6c9e6" : "#8ff0ff")
  return (
    <g
      transform={`translate(${props.x} ${props.y}) scale(${props.s})`}
      class={props.status === "running" ? "hq-running" : undefined}
      data-hq-bot={props.status}
    >
      <Show when={!props.noLamp && CONE[props.status]}>
        {(cone) => (
          <>
            <path class="hq-cone" d="M-7 -104 L-34 4 L34 4 L7 -104 Z" fill={props.url(cone())} data-hq-cone="" />
            <ellipse cx={0} cy={-105} rx={9} ry={3} fill={c()} />
          </>
        )}
      </Show>
      <ellipse
        class="hq-ring"
        cx={0}
        cy={5}
        rx={30}
        ry={8}
        fill="none"
        stroke={props.status === "blocked" || props.status === "waiting" ? c() : v("--hq-line-2")}
        stroke-dasharray={props.status === "blocked" ? "3 3" : "none"}
        stroke-width={1.2}
      />
      <ellipse cx={0} cy={5} rx={22} ry={5.5} fill="#000" opacity={0.28} />
      <g class="hq-bob">
        <rect x={-12} y={-14} width={9} height={16} rx={4} fill={v("--hq-shell-2")} />
        <rect x={3} y={-14} width={9} height={16} rx={4} fill={v("--hq-shell-2")} />
        <rect x={-25} y={-42} width={9} height={20} rx={4.5} fill={F()} />
        <rect x={16} y={-42} width={9} height={20} rx={4.5} fill={F()} />
        <rect x={-17} y={-46} width={34} height={34} rx={11} fill={props.url("shell")} />
        <rect x={-17} y={-46} width={34} height={34} rx={11} fill={F()} opacity={0.55} />
        <rect x={-7} y={-38} width={14} height={11} rx={3} fill="none" stroke={v("--hq-shell")} stroke-width={1.6} opacity={0.9} />
        <rect x={-21} y={-84} width={42} height={36} rx={14} fill={props.url("shell")} />
        <path d={HELMET[props.family]} fill={F()} />
        <rect x={-16} y={-72} width={32} height={18} rx={8} fill={v("--hq-visor")} />
        <rect x={-10} y={-66} width={7} height={6} rx={3} fill={eye()} />
        <rect x={3} y={-66} width={7} height={6} rx={3} fill={eye()} />
        <rect x={-13} y={-70} width={8} height={2} rx={1} fill="#fff" opacity={0.18} />
        <path d="M-16 -74 Q-15 -81 -7 -82" fill="none" stroke="#fff" stroke-width={2} opacity={0.55} stroke-linecap="round" />
        <g transform="translate(23 -20) rotate(-10)">
          <rect x={-10} y={-10} width={20} height={20} rx={5} fill={v("--hq-card")} stroke={F()} stroke-width={1.6} />
          <path d={TOOL[props.tool]} fill="none" stroke={F()} stroke-width={1.7} stroke-linecap="round" stroke-linejoin="round" />
        </g>
        <Show when={props.halo}>
          <ellipse cx={0} cy={-97} rx={17} ry={4.5} fill="none" stroke={v("--hq-glow")} stroke-width={2.4} />
          <ellipse cx={0} cy={-97} rx={24} ry={7} fill="none" stroke={v("--hq-glow")} stroke-opacity={0.3} />
        </Show>
      </g>
      <Show when={BADGE[props.status]}>
        {(badge) => (
          <g transform="translate(19 -84)" data-hq-badge={props.status}>
            <circle r={8} fill={c()} stroke={v("--hq-stage")} stroke-width={2} />
            <path d={badge()[0]} stroke={badge()[1]} stroke-width={1.9} fill="none" stroke-linecap="round" />
          </g>
        )}
      </Show>
    </g>
  )
}

/** The owner on the deck (V6:225-240). */
function Person(props: { x: number; y: number; s: number }) {
  return (
    <g transform={`translate(${props.x} ${props.y}) scale(${props.s})`} data-hq-you="">
      <ellipse cx={0} cy={5} rx={22} ry={5.5} fill="#000" opacity={0.28} />
      <rect x={-11} y={-16} width={9} height={18} rx={4} fill="#24333c" />
      <rect x={2} y={-16} width={9} height={18} rx={4} fill="#24333c" />
      <rect x={-24} y={-45} width={9} height={25} rx={4.5} fill="#2f4552" />
      <rect x={15} y={-45} width={9} height={25} rx={4.5} fill="#2f4552" />
      <path d="M-17 -12 V-36 Q-17 -48 0 -48 Q17 -48 17 -36 V-12 Q17 -10 15 -10 H-15 Q-17 -10 -17 -12 Z" fill="#2f4552" />
      <path d="M-7 -48 L0 -38 L7 -48" fill="none" stroke={v("--hq-glow")} stroke-width={2.4} stroke-linejoin="round" />
      <rect x={-13} y={-33} width={7} height={3} rx={1.5} fill={v("--hq-glow")} />
      <rect x={-4} y={-54} width={8} height={7} fill="#bf8b68" />
      <circle cx={0} cy={-66} r={14} fill="#d4a07c" />
      <path d="M-14 -67 Q-15 -83 0 -82 Q15 -83 14 -67 Q9 -76 -2 -75 Q-9 -75 -14 -67 Z" fill="#2d221b" />
      <circle cx={-5} cy={-64} r={1.7} fill="#1d1410" />
      <circle cx={5} cy={-64} r={1.7} fill="#1d1410" />
      <path d="M-15.5 -66 Q-16 -85 0 -85 Q16 -85 15.5 -66" fill="none" stroke={v("--hq-glow")} stroke-width={2.4} />
      <rect x={-19} y={-71} width={6} height={10} rx={2.5} fill={v("--hq-glow")} />
      <path d="M-16 -62 Q-14 -55 -6 -56" fill="none" stroke={v("--hq-glow")} stroke-width={1.6} stroke-linecap="round" />
    </g>
  )
}

/** Raised tier (V6:252-254). */
function Tier(props: { url: Url; x: number; y: number; rx: number; ry: number; h: number; rim: string; op?: number }) {
  return (
    <>
      <path
        d={`M${props.x - props.rx} ${props.y} V${props.y + props.h} A${props.rx} ${props.ry} 0 0 0 ${props.x + props.rx} ${props.y + props.h} V${props.y} Z`}
        fill={props.url("tierSide")}
        stroke={v("--hq-line-2")}
        stroke-width={1}
      />
      <ellipse
        cx={props.x}
        cy={props.y}
        rx={props.rx}
        ry={props.ry}
        fill={props.url("tierTop")}
        stroke={props.rim}
        stroke-width={1.5}
        stroke-opacity={props.op ?? 1}
      />
    </>
  )
}

function Stops(props: { stops: Array<[number, string, number]> }) {
  return <For each={props.stops}>{([offset, color, opacity]) => <stop offset={offset} style={{ "stop-color": v(color), "stop-opacity": opacity }} />}</For>
}

/** Gradients shared by every drawing (V6:126-131, :243-250), ids made unique per instance. */
function Defs(props: { id: string }) {
  const id = (n: string) => `${props.id}-${n}`
  return (
    <defs>
      <linearGradient id={id("shell")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-shell", 1], [1, "--hq-shell-2", 1]]} />
      </linearGradient>
      <linearGradient id={id("coneRun")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-run", 0.55], [1, "--hq-run", 0]]} />
      </linearGradient>
      <linearGradient id={id("coneReview")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-review", 0.55], [1, "--hq-review", 0]]} />
      </linearGradient>
      <linearGradient id={id("coneIssue")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-issue", 0.6], [1, "--hq-issue", 0]]} />
      </linearGradient>
      <radialGradient id={id("hqHalo")}>
        <Stops stops={[[0, "--hq-glow", 0.3], [1, "--hq-glow", 0]]} />
      </radialGradient>
      <linearGradient id={id("beam")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-glow", 0], [1, "--hq-glow", 0.45]]} />
      </linearGradient>
      <radialGradient id={id("holo")}>
        <Stops stops={[[0, "--hq-glow", 0.24], [1, "--hq-glow", 0.03]]} />
      </radialGradient>
      <linearGradient id={id("tierTop")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-card-2", 1], [1, "--hq-card", 1]]} />
      </linearGradient>
      <linearGradient id={id("tierSide")} x1="0" y1="0" x2="0" y2="1">
        <Stops stops={[[0, "--hq-card", 1], [1, "--hq-stage", 1]]} />
      </linearGradient>
      <pattern id={id("grid")} width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0H0V40" fill="none" stroke={v("--hq-line")} stroke-width="1" />
      </pattern>
      <For each={FAMILIES}>
        {(f) => (
          <>
            <linearGradient id={id(`wall-${f}`)} x1="0" y1="0" x2="0" y2="1">
              <Stops stops={[[0, familyColor(f), 0.2], [1, familyColor(f), 0]]} />
            </linearGradient>
            <radialGradient id={id(`pool-${f}`)}>
              <Stops stops={[[0, familyColor(f), 0.3], [1, familyColor(f), 0]]} />
            </radialGradient>
          </>
        )}
      </For>
    </defs>
  )
}

function keyActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    fn()
  }
}

/**
 * Row 136 M3: stable keys for a list rebuilt on every poll. `<For>` keys by object identity, so a new room or spot object
 * would re-create its DOM and drop keyboard focus. The ids are memoised as one string (as swarm-view.tsx:361-368) and
 * each item is looked up by id, so a node stays mounted while its id stays.
 */
function keyedIds<T>(list: () => T[], key: (item: T) => string) {
  const joined = createMemo(() => list().map(key).join("\n"))
  const ids = createMemo(() => joined().split("\n").filter(Boolean))
  const byId = createMemo(() => new Map(list().map((item) => [key(item), item])))
  return { ids, get: (id: string) => byId().get(id) }
}

/** One agent spot per row id of a room, keyed by row id. */
function SpotsOf(p: { agents: AgentSpot[]; children: (spot: () => AgentSpot) => JSX.Element }) {
  const spots = keyedIds(() => p.agents, (spot) => spot.rowId)
  return <For each={spots.ids()}>{(rowId) => <Show when={spots.get(rowId)}>{(spot) => p.children(spot)}</Show>}</For>
}

export function MissionHQ(props: MissionHQProps) {
  const language = useLanguage()
  const uid = `hq${createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const url: Url = (n) => `url(#${uid}-${n})`
  let host: HTMLDivElement | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => {
    const read = () => setMeasured(host?.clientWidth ?? 0)
    read()
    if (typeof ResizeObserver === "undefined" || !host) return
    const observer = new ResizeObserver(read)
    observer.observe(host)
    onCleanup(() => observer.disconnect())
  })
  const scene = createMemo(() => hqScene(props.mission, props.width ?? measured()))
  const statusLabel = (s: MissionAgentStatus) => language.t(`session.mission.agent.${s}` as "session.mission.agent.running")
  const open = () => props.mission.decision !== null
  const progress = () => props.mission.progress

  /** One agent: robot, document marker, hit area, optional label and checkpoint bar (V6:268-281). */
  const Agent = (p: { rowId: string; x: number; y: number; s: number; label: boolean }) => {
    const agent = (): MissionAgentVM | undefined => props.mission.agents[p.rowId]
    const deliverable = () => {
      const id = agent()?.deliverableId
      return id ? props.mission.deliverables.find((d) => d.documentId === id) : undefined
    }
    const select = () => props.onSelectAgent?.(p.rowId)
    return (
      <Show when={agent()}>
        {(a) => (
          <g
            class="hq-agent"
            tabindex={0}
            role="button"
            aria-label={language.t("session.mission.agent.aria", { agent: a().agent, title: a().title, status: statusLabel(a().status) })}
            aria-pressed={props.selected === p.rowId}
            data-hq-agent={p.rowId}
            data-status={a().status}
            onClick={select}
            onKeyDown={keyActivate(select)}
          >
            <Bot url={url} family={a().family} tool={a().tool} status={a().status} x={p.x} y={p.y} s={p.s} />
            <Show when={deliverable()}>
              {(d) => (
                <g transform={`translate(${p.x - 25 * p.s} ${p.y - 24 * p.s}) scale(${p.s})`} data-hq-doc={d().status}>
                  <path d="M-7 -9 H3 L7 -5 V9 H-7 Z" fill={v("--hq-card")} stroke={v(DELIVERABLE_COLOR[d().status])} stroke-width={1.6} stroke-linejoin="round" />
                  <path d="M-4 -2 H4 M-4 2 H4 M-4 6 H1" stroke={v("--hq-ink-3")} stroke-width={1.2} stroke-linecap="round" />
                </g>
              )}
            </Show>
            <rect x={p.x - 46 * p.s} y={p.y - 108 * p.s} width={92 * p.s} height={108 * p.s + 40} fill="transparent" />
            <Show when={p.label}>
              <text
                x={p.x}
                y={p.y + 26 * p.s + 8}
                text-anchor="middle"
                font-size={p.s < 0.75 ? "11.5" : "12.5"}
                font-weight="500"
                fill={v(props.selected === p.rowId ? "--hq-ink" : "--hq-ink-2")}
                data-hq-label=""
              >
                {agentLabel(a().title)}
              </text>
              <rect x={p.x - 26} y={p.y + 26 * p.s + 15} width={52} height={3} rx={1.5} fill={v("--hq-line")} />
              <rect
                x={p.x - 26}
                y={p.y + 26 * p.s + 15}
                width={52 * checkpointFill(a())}
                height={3}
                rx={1.5}
                fill={v(STATUS_COLOR[a().status])}
                data-hq-checkpoint={a().checkpoint ? `${a().checkpoint!.n}/${a().checkpoint!.m}` : ""}
              />
            </Show>
          </g>
        )}
      </Show>
    )
  }

  const Beacon = (p: { x: number; y: number; w: number; dot: number; text: string }) => (
    <g
      class="hq-beacon"
      role="button"
      tabindex={0}
      aria-label={language.t("session.mission.decision.open", { id: props.mission.decision!.id })}
      data-hq-beacon={props.mission.decision!.id}
      onClick={() => props.onOpenDecision?.()}
      onKeyDown={keyActivate(() => props.onOpenDecision?.())}
    >
      <rect x={p.x} y={p.y - 12} width={p.w} height={24} rx={12} fill={v("--hq-card")} stroke={v("--hq-review")} stroke-width={1.4} />
      <circle class="hq-ping" cx={p.dot} cy={p.y} r={6} fill="none" stroke={v("--hq-review")} />
      <circle cx={p.dot} cy={p.y} r={4} fill={v("--hq-review")} />
      <text x={p.dot + 12} y={p.y + 4} font-family={MONO} font-size="11" fill={v("--hq-ink")}>
        {p.text}
      </text>
    </g>
  )

  const Radial = (p: { s: RadialScene }) => {
    const { cx, cy, hy } = p.s
    const rooms = keyedIds(() => p.s.rooms, (room) => room.phase.id)
    return (
      <>
        <g data-hq-floor="">
          <For each={[[470, "2 10", 0.5], [350, "none", 0.35], [250, "none", 0.25]] as Array<[number, string, number]>}>
            {([r, da, op]) => (
              <ellipse cx={cx} cy={cy + 14} rx={r} ry={r * 0.34} fill="none" stroke={v("--hq-line-2")} stroke-opacity={op} stroke-dasharray={da} />
            )}
          </For>
          <For each={p.s.spokes}>{(l) => <line {...l} stroke={v("--hq-line-2")} stroke-opacity={0.18} />}</For>
          <For each={p.s.rooms}>
            {(room) => (
              <>
                <line {...room.conduit} stroke={v("--hq-line")} stroke-width={7} stroke-linecap="round" stroke-opacity={0.8} />
                <line
                  {...room.conduit}
                  class={room.phase.live ? "hq-flow" : undefined}
                  stroke={v(room.phase.live ? "--hq-run" : "--hq-line-2")}
                  stroke-width={1.6}
                  stroke-linecap="round"
                  data-hq-conduit={room.phase.live ? "live" : "idle"}
                />
              </>
            )}
          </For>
        </g>
        <g data-hq-deck="">
          <ellipse cx={cx} cy={cy - 50} rx={260} ry={200} fill={url("hqHalo")} />
          <ellipse class="hq-orbit" cx={cx} cy={cy + 14} rx={218} ry={72} fill="none" stroke={v("--hq-glow")} stroke-opacity={0.55} stroke-dasharray="3 9" />
          <Tier url={url} x={cx} y={cy + 14} rx={190} ry={58} h={12} rim={v("--hq-line-2")} />
          <Tier url={url} x={cx} y={cy + 2} rx={150} ry={45} h={10} rim={v("--hq-line-2")} />
          <g data-hq-rim={open() ? "review" : "glow"}>
            <Tier url={url} x={cx} y={cy - 8} rx={112} ry={33} h={8} rim={v(open() ? "--hq-review" : "--hq-glow")} />
          </g>
          <ellipse cx={cx} cy={cy - 8} rx={94} ry={25} fill="none" stroke={v("--hq-glow")} stroke-opacity={0.4} stroke-dasharray="1 5" />
          <text x={cx} y={cy + 82} text-anchor="middle" font-family={MONO} font-size="9.5" letter-spacing=".32em" fill={v("--hq-glow")}>
            {language.t("session.mission.hq").toUpperCase()}
          </text>
          <path d={`M${cx - 18} ${hy + 44} L${cx - 60} ${cy - 8} Q${cx} ${cy + 10} ${cx + 60} ${cy - 8} L${cx + 18} ${hy + 44} Z`} fill={url("beam")} />
          <g transform={`translate(${cx} ${hy})`} data-hq-ring="">
            <circle r={52} fill={url("holo")} />
            <For each={Array.from({ length: 48 }, (_, k) => k)}>
              {(k) => {
                const a = (k / 48) * Math.PI * 2
                const r1 = k % 4 ? 57 : 53
                return (
                  <line
                    x1={Math.cos(a) * r1}
                    y1={Math.sin(a) * r1}
                    x2={Math.cos(a) * 60}
                    y2={Math.sin(a) * 60}
                    stroke={v("--hq-glow")}
                    stroke-opacity={k % 4 ? 0.3 : 0.75}
                  />
                )
              }}
            </For>
            <circle class="hq-orbit" r={67} fill="none" stroke={v("--hq-glow")} stroke-opacity={0.5} stroke-width={1.5} stroke-dasharray="34 56 10 40" />
            <circle r={46} fill="none" stroke={v("--hq-line-2")} stroke-width={5} />
            <circle
              r={46}
              fill="none"
              stroke={v("--hq-glow")}
              stroke-width={5}
              stroke-linecap="round"
              pathLength={100}
              stroke-dasharray={`${progress().pct} 100`}
              transform="rotate(-90)"
              data-hq-arc={progress().pct}
            />
            <text y={7} text-anchor="middle" font-size="27" font-weight="600" fill={v("--hq-ink")} data-hq-pct="">
              {`${progress().pct}%`}
            </text>
            <text y={25} text-anchor="middle" font-family={MONO} font-size="11" fill={v("--hq-ink-2")} data-hq-count="">
              {`${progress().done}/${progress().total}`}
            </text>
          </g>
          <Person x={cx - 74} y={cy - 4} s={0.92} />
          <Bot url={url} family="plan" tool="hub" status="running" x={cx + 74} y={cy - 4} s={0.92} noLamp color="--hq-glow" halo />
          <text x={cx - 74} y={cy + 20} text-anchor="middle" font-size="11.5" font-weight="600" fill={v("--hq-ink")} data-hq-you-label="">
            {language.t("session.mission.you")}
          </text>
          <text x={cx + 74} y={cy + 20} text-anchor="middle" font-size="11.5" font-weight="600" fill={v("--hq-ink")} data-hq-swarm-label="">
            {language.t("session.mission.swarm")}
          </text>
          <Show when={props.mission.decision}>
            {(d) => (
              <>
                <line x1={cx} y1={hy - 78} x2={cx} y2={hy - 68} stroke={v("--hq-review")} stroke-dasharray="2 4" />
                <Beacon x={cx - 66} y={hy - 90} w={132} dot={cx - 50} text={language.t("session.mission.decision.beacon", { id: d().id })} />
              </>
            )}
          </Show>
        </g>
        <g data-hq-rooms="">
          <For each={rooms.ids()}>
            {(phaseId) => (
              <Show when={rooms.get(phaseId)}>
                {(room) => {
                  const fam = () => room().phase.family
                  const F = () => v(familyColor(fam()))
                  const all = () => room().phase.allDone
                  const sw = () => room().signWidth
                  return (
                    <g data-hq-room={phaseId} data-family={fam()} data-live={room().phase.live ? "" : undefined}>
                      <ellipse cx={room().x} cy={room().py} rx={room().rx + 34} ry={room().ry + 18} fill={url(`pool-${fam()}`)} />
                      <path d={`${room().dome} Z`} fill={url(`wall-${fam()}`)} />
                      <path d={room().dome} fill="none" stroke={F()} stroke-opacity={0.3} />
                      <Tier url={url} x={room().x} y={room().py} rx={room().rx} ry={room().ry} h={10} rim={all() ? v("--hq-done") : F()} op={all() ? 1 : 0.75} />
                      <ellipse cx={room().x} cy={room().py} rx={room().rx - 18} ry={room().ry - 8} fill="none" stroke={F()} stroke-opacity={0.25} stroke-dasharray="2 6" />
                      <g transform={`translate(${room().x} ${room().ty})`}>
                        <rect x={-sw() / 2} y={-13} width={sw()} height={26} rx={13} fill={v("--hq-card")} stroke={F()} stroke-opacity={0.75} />
                        <circle cx={-sw() / 2 + 14} cy={0} r={3.5} fill={v(room().phase.live ? "--hq-run" : all() ? "--hq-done" : "--hq-wait")} data-hq-dot="" />
                        <text x={-sw() / 2 + 24} y={4} font-family={MONO} font-size="11" letter-spacing=".16em" fill={F()} data-hq-room-name="">
                          {room().phase.name.toUpperCase()}
                        </text>
                        <text x={sw() / 2 - 12} y={4} text-anchor="end" font-family={MONO} font-size="10.5" fill={v(all() ? "--hq-done" : "--hq-ink-2")} data-hq-room-count="">
                          {`${room().phase.done}/${room().phase.total}`}
                        </text>
                      </g>
                      <SpotsOf agents={room().agents}>
                        {(spot) => <Agent rowId={spot().rowId} x={spot().x} y={spot().y} s={spot().s} label />}
                      </SpotsOf>
                    </g>
                  )
                }}
              </Show>
            )}
          </For>
        </g>
      </>
    )
  }

  const Lanes = (p: { s: LanesScene }) => {
    const W = p.s.width
    const lanes = keyedIds(() => p.s.lanes, (lane) => lane.phase.id)
    return (
      <>
        <g data-hq-deck="">
          <g data-hq-rim={open() ? "review" : "glow"}>
            <rect x={10} y={10} width={W - 20} height={72} rx={14} fill={url("tierTop")} stroke={v(open() ? "--hq-review" : "--hq-glow")} stroke-opacity={0.8} stroke-width={1.3} />
          </g>
          <ellipse cx={62} cy={70} rx={60} ry={14} fill={url("hqHalo")} />
          <Person x={42} y={72} s={0.5} />
          <Bot url={url} family="plan" tool="hub" status="running" x={84} y={72} s={0.5} noLamp color="--hq-glow" halo />
          <text x={122} y={36} font-family={MONO} font-size="9.5" letter-spacing=".28em" fill={v("--hq-glow")}>
            HQ
          </text>
          <text x={122} y={64} font-size="25" font-weight="600" fill={v("--hq-ink")} data-hq-pct="">
            {`${progress().pct}%`}
          </text>
          <text x={184} y={64} font-family={MONO} font-size="12" fill={v("--hq-ink-2")} data-hq-count="">
            {`${progress().done}/${progress().total}`}
          </text>
          <Show when={props.mission.decision}>
            {(d) => <Beacon x={W - 128} y={46} w={106} dot={W - 114} text={language.t("session.mission.decision.beacon", { id: d().id })} />}
          </Show>
        </g>
        <g data-hq-rooms="">
          <For each={lanes.ids()}>
            {(phaseId) => (
              <Show when={lanes.get(phaseId)}>
                {(lane) => {
                  const fam = () => lane().phase.family
                  const F = () => v(familyColor(fam()))
                  const all = () => lane().phase.allDone
                  return (
                    <g data-hq-room={phaseId} data-family={fam()} data-live={lane().phase.live ? "" : undefined}>
                      <rect x={10} y={lane().y} width={W - 20} height={lane().h} rx={12} fill={url(`wall-${fam()}`)} stroke={all() ? v("--hq-done") : F()} stroke-opacity={all() ? 1 : 0.45} />
                      <rect x={10} y={lane().y + 12} width={3} height={lane().h - 24} rx={1.5} fill={F()} />
                      <circle cx={W - 22 - 46} cy={lane().y + 14.5} r={3} fill={v(lane().phase.live ? "--hq-run" : all() ? "--hq-done" : "--hq-wait")} data-hq-dot="" />
                      <text x={24} y={lane().y + 18} font-family={MONO} font-size="10.5" letter-spacing=".16em" fill={F()} data-hq-room-name="">
                        {lane().phase.name.toUpperCase()}
                      </text>
                      <text x={W - 22} y={lane().y + 18} text-anchor="end" font-family={MONO} font-size="10.5" fill={v(all() ? "--hq-done" : "--hq-ink-3")} data-hq-room-count="">
                        {`${lane().phase.done}/${lane().phase.total}`}
                      </text>
                      <SpotsOf agents={lane().agents}>
                        {(spot) => <Agent rowId={spot().rowId} x={spot().x} y={spot().y} s={spot().s} label={false} />}
                      </SpotsOf>
                    </g>
                  )
                }}
              </Show>
            )}
          </For>
        </g>
      </>
    )
  }

  const style = (): JSX.CSSProperties => ({ ...HQ_TOKENS })

  return (
    <div ref={host} class="hq-root" style={style()} data-mission-hq={scene().mode} data-mission-type={props.mission.type}>
      <style>{CSS}</style>
      <svg
        viewBox={`0 0 ${scene().width} ${scene().height}`}
        preserveAspectRatio={scene().mode === "radial" ? "xMidYMid meet" : "xMidYMin meet"}
        role="img"
        aria-label={`${language.t("session.mission.hq")}: ${progress().pct}% · ${progress().done}/${progress().total}`}
      >
        <Defs id={uid} />
        <rect x="0" y="0" width="100%" height="100%" fill={url("grid")} opacity={0.3} />
        <Show when={scene().mode === "radial"} fallback={<Lanes s={scene() as LanesScene} />}>
          <Radial s={scene() as RadialScene} />
        </Show>
      </svg>
      <Show when={scene().mode === "radial"}>
        <div class="hq-legend" data-hq-legend="">
          <For each={STATUS_ORDER}>
            {(s) => (
              <span>
                <i style={{ background: v(STATUS_COLOR[s]) }} />
                {statusLabel(s)}
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
