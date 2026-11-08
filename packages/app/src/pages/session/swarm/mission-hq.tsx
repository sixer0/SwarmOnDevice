// HQ command deck (row 130; masterplan/01_specs_mission_control_ui.md §5.3, §6 items 5-19, 38, 41; decisions U20, C59).
// The visual of report/mission_control_master.html (v6): You + Swarm on the tiered deck, the hologram progress ring,
// the decision beacon, the lit phase rooms of the mission type with one role robot per row, status badges, lamp cones
// and conduits; a compact lanes layout below 540 px. Draws the row 129 model only (no re-derivation) and renders every
// mission string as a text node (§12). Geometry: mission-hq-scene.ts.

import { useLanguage } from "@/context/language"
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { MissionAgentStatus, MissionAgentVM, MissionFamily, MissionTool, MissionVM } from "./mission-model"
import {
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
  type RadialRoom,
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

// Beacon pill geometry (row 133b): dot centre and text start from the pill's left edge, mono font size and advance.
// SF Mono / Menlo advance is 0.6 em; 0.62 em leaves a margin for the fallback monospace face.
const BEACON_DOT = 14
const BEACON_TEXT = 26
const BEACON_PAD = 12
const BEACON_FONT = 11
const BEACON_ADVANCE = BEACON_FONT * 0.62

/** Pill width sized to the beacon text; text longer than `max` allows is cut with an ellipsis. */
export function beaconPill(text: string, max: number): { text: string; w: number } {
  const chars = Array.from(text)
  const widthOf = (n: number) => Math.ceil(BEACON_TEXT + n * BEACON_ADVANCE + BEACON_PAD)
  if (widthOf(chars.length) <= max) return { text, w: widthOf(chars.length) }
  const fit = Math.max(1, Math.floor((max - BEACON_TEXT - BEACON_PAD) / BEACON_ADVANCE) - 1)
  return { text: `${chars.slice(0, fit).join("").trimEnd()}…`, w: widthOf(fit + 1) }
}

// Row 167 (user finding 2026-11-08, "layoutnya ada yang berbenturan"): the scene's rooms put a 3-agent room into two
// lines of 2 that float in the dome above the platform with labels crammed side by side, and the decision beacon sat on
// the ring's ticks. The room interior and the beacon are re-laid here, pure, so the geometry test checks exactly what
// is drawn: agents stand ON the platform (one row up to 3; 4+ in a staggered back/front pair of rows, scaled down),
// every label is cut to the width its slot allows, and the sign pill sits above everything in the room.
// (To be moved into mission-hq-scene.ts when that file is free; see delegation_progress/file_requests.md row 167.)

/** Robot extents in robot units (Bot: tool box to x 33, doc marker to x -32, lamp cone top y -108, ring y 13). */
export const BOT_HALF_W = 34
export const BOT_TOP = 108
export const BOT_BOTTOM = 13
/** Width estimate per character of the label's sans face (proportional fonts average ~0.5 em; 0.6 em is a margin). */
export const LABEL_ADVANCE = 0.6
const LABEL_H = 20 // text (13) + gap + checkpoint bar (3)

export type HqBox = { x: number; y: number; w: number; h: number }
/** Label slot: text baseline at y, max width w, checkpoint bar at barY. */
export type HqLabel = { x: number; y: number; fs: number; w: number; chars: number; barY: number; barW: number }
export type HqSpot = AgentSpot & { label: HqLabel }
export type HqRoom = Omit<RadialRoom, "agents"> & { agents: HqSpot[] }
export type HqRadial = Omit<RadialScene, "rooms"> & {
  rooms: HqRoom[]
  beacon: { x: number; y: number; lineTop: number; lineBottom: number }
}

/** Title cut to `chars` characters, ellipsis included (§5.4 keeps 12 + "…" at most). */
export function fitLabel(title: string, chars: number) {
  const list = Array.from(title)
  const max = Math.max(2, Math.min(13, chars))
  return list.length > max ? list.slice(0, max - 1).join("") + "…" : title
}

export const botBox = (a: AgentSpot): HqBox => ({
  x: a.x - BOT_HALF_W * a.s,
  y: a.y - BOT_TOP * a.s,
  w: 2 * BOT_HALF_W * a.s,
  h: (BOT_TOP + BOT_BOTTOM) * a.s,
})
export const labelBox = (l: HqLabel): HqBox => ({ x: l.x - l.w / 2, y: l.y - 11, w: l.w, h: l.barY + 3 - (l.y - 11) })

function slot(x: number, top: number, fs: number, w: number): HqLabel {
  // top = upper edge of the label block: text (baseline top + 11), then the bar 4 below the baseline
  const y = top + 11
  return { x, y, fs, w, chars: Math.floor(w / (fs * LABEL_ADVANCE)), barY: y + 4, barW: Math.min(52, w) }
}

/** One room: agents on the platform, labels in slots, pill above the room. Keeps the scene's centre x and floor. */
export function layoutRoom(room: RadialRoom, cx: number, cy: number): HqRoom {
  const x0 = room.x
  const py = room.py
  const n = room.agents.length
  let agents: HqSpot[]
  let rx: number
  let ry: number
  let top: number // highest point of the room's content
  if (n <= 3) {
    const s = 0.8
    const dx = n === 3 ? 96 : 104 // n <= 2 keeps the §5.4 cut (12 + "…"); 3 in a row cut to 11 + "…"
    const fs = n === 1 ? 12.5 : 12
    const w = n === 1 ? 104 : dx - 8
    const feet = py - 4
    agents = room.agents.map((a, j) => {
      const x = x0 + (j - (n - 1) / 2) * dx
      return { rowId: a.rowId, x, y: feet, s, label: slot(x, feet + BOT_BOTTOM * s + 3, fs, w) }
    })
    rx = Math.max(105, ((n - 1) * dx) / 2 + Math.max(BOT_HALF_W * s, w / 2) + 16)
    ry = 30
    top = feet - BOT_TOP * s
  } else {
    // staggered rows: neighbours alternate back/front, so bots never overlap even when their x distance (h) is small;
    // back labels sit above the back robots, front labels below the front robots, each 2h wide.
    const h = Math.min(46, (2 * (150 - 38)) / (n - 1))
    const s = Math.min(0.62, (h - 3) / (2 * BOT_HALF_W))
    const fs = 11
    const w = 2 * h - 6
    const back = py - 16
    const front = py + 6
    agents = room.agents.map((a, j) => {
      const x = x0 + (j - (n - 1) / 2) * h
      const isBack = j % 2 === 1
      const y = isBack ? back : front
      const label = isBack ? slot(x, y - BOT_TOP * s - 4 - LABEL_H, fs, w) : slot(x, y + BOT_BOTTOM * s + 3, fs, w)
      return { rowId: a.rowId, x, y, s, label }
    })
    rx = Math.max(105, ((n - 1) * h) / 2 + Math.max(BOT_HALF_W * s, w / 2) + 16)
    ry = 34
    top = n > 1 ? back - BOT_TOP * s - 4 - LABEL_H : front - BOT_TOP * s
  }
  const ty = top - 6 - 13
  const vx = x0 - cx
  const vy = py - (cy + 14)
  const t = 1 / Math.hypot(vx / 192, vy / 60)
  return {
    ...room,
    rx,
    ry,
    ty,
    dome: `M${x0 - rx + 10} ${py} A${rx - 10} ${py - ty + 4} 0 0 1 ${x0 + rx - 10} ${py}`,
    // a room straight below the deck: start under the "HQ · COMMAND DECK" title (baseline cy + 82), not through it
    conduit: { x1: cx + vx * t, y1: Math.abs(vx) < 90 ? Math.max(cy + 14 + vy * t, cy + 90) : cy + 14 + vy * t, x2: x0 - vx * 0.18, y2: py - vy * 0.12 },
    agents,
  }
}

/** Lanes: robots 6 lower so the lamp cone clears the lane's name and count line (they still end inside the lane). */
export function layoutLanes(scene: LanesScene): LanesScene {
  return { ...scene, lanes: scene.lanes.map((lane) => ({ ...lane, agents: lane.agents.map((a) => ({ ...a, y: a.y + 6 })) })) }
}

/** The radial scene with the rooms re-laid and the decision beacon lifted clear of the ring (ring orbit top hy - 67). */
export function layoutRadial(scene: RadialScene): HqRadial {
  const y = scene.hy - 122
  return {
    ...scene,
    rooms: scene.rooms.map((room) => layoutRoom(room, scene.cx, scene.cy)),
    beacon: { x: scene.cx, y, lineTop: y + 12, lineBottom: scene.hy - 69 },
  }
}

// Static CSS only (no mission text). Motion is off under prefers-reduced-motion (§6 item 41, V6:94).
const CSS = `
.hq-root{position:relative;width:100%;color:var(--hq-ink);background:radial-gradient(120% 90% at 50% 52%,var(--hq-stage-2),var(--hq-stage) 70%);border-radius:12px;overflow:hidden}
.hq-root svg{display:block;width:100%;height:auto}
.hq-root[data-mission-hq="radial"]{height:100%;display:flex;flex-direction:column}
.hq-root[data-mission-hq="radial"] svg{flex:1 1 0;min-height:0;height:100%}
.hq-root[data-mission-hq="radial"] .hq-legend{flex:none}
.hq-agent,.hq-beacon{cursor:pointer;outline:none}
.hq-agent:focus-visible .hq-ring{stroke:var(--hq-glow);stroke-width:2}
.hq-beacon:focus-visible rect{stroke-width:2.4}
.hq-legend{display:flex;justify-content:center;padding:4px 12px 10px;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--hq-ink-2);pointer-events:none}
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
@keyframes hq-orbit-dash{to{stroke-dashoffset:-120}}
.hq-orbit-dash{animation:hq-orbit-dash 12s linear infinite}
.hq-ping{animation:hq-ping 1.6s ease-out infinite}
@media (prefers-reduced-motion:reduce){.hq-running .hq-bob,.hq-running .hq-cone,.hq-flow,.hq-orbit,.hq-orbit-dash,.hq-ping{animation:none}}
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

const rectOf = (b: HqBox) => ({ x: b.x, y: b.y, width: b.w, height: b.h })
const botRect = (a: AgentSpot) => rectOf(botBox(a))

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
  const Agent = (p: { rowId: string; x: number; y: number; s: number; label?: HqLabel }) => {
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
            <rect {...botRect(p)} fill="transparent" data-hq-hit="" />
            <Show when={p.label}>{(l) => <rect {...rectOf(labelBox(l()))} fill="transparent" />}</Show>
            <Show when={p.label}>
              {(l) => (
                <>
                  <text
                    x={l().x}
                    y={l().y}
                    text-anchor="middle"
                    font-size={String(l().fs)}
                    font-weight="500"
                    fill={v(props.selected === p.rowId ? "--hq-ink" : "--hq-ink-2")}
                    data-hq-label=""
                  >
                    {fitLabel(a().title, l().chars)}
                  </text>
                  <rect x={l().x - l().barW / 2} y={l().barY} width={l().barW} height={3} rx={1.5} fill={v("--hq-line")} />
                  <rect
                    x={l().x - l().barW / 2}
                    y={l().barY}
                    width={l().barW * checkpointFill(a())}
                    height={3}
                    rx={1.5}
                    fill={v(STATUS_COLOR[a().status])}
                    data-hq-checkpoint={a().checkpoint ? `${a().checkpoint!.n}/${a().checkpoint!.m}` : ""}
                  />
                </>
              )}
            </Show>
          </g>
        )}
      </Show>
    )
  }

  // Row 133b (C175, row 144 O-1): the pill is sized to its text; `anchor` is the pill's left edge ("start"), centre
  // ("middle") or right edge ("end"), and text longer than `max` is cut with an ellipsis (full text stays in aria-label).
  const Beacon = (p: { x: number; y: number; anchor: "start" | "middle" | "end"; max: number; text: string }) => {
    const pill = () => beaconPill(p.text, p.max)
    const left = () => (p.anchor === "start" ? p.x : p.anchor === "middle" ? p.x - pill().w / 2 : p.x - pill().w)
    return (
      <g
        class="hq-beacon"
        role="button"
        tabindex={0}
        aria-label={language.t("session.mission.decision.open", { id: props.mission.decision!.id })}
        data-hq-beacon={props.mission.decision!.id}
        data-hq-beacon-w={pill().w}
        onClick={() => props.onOpenDecision?.()}
        onKeyDown={keyActivate(() => props.onOpenDecision?.())}
      >
        <rect x={left()} y={p.y - 12} width={pill().w} height={24} rx={12} fill={v("--hq-card")} stroke={v("--hq-review")} stroke-width={1.4} />
        <circle class="hq-ping" cx={left() + BEACON_DOT} cy={p.y} r={6} fill="none" stroke={v("--hq-review")} />
        <circle cx={left() + BEACON_DOT} cy={p.y} r={4} fill={v("--hq-review")} />
        <text x={left() + BEACON_TEXT} y={p.y + 4} font-family={MONO} font-size={String(BEACON_FONT)} fill={v("--hq-ink")}>
          {pill().text}
        </text>
      </g>
    )
  }

  const Radial = (p: { s: RadialScene }) => {
    const { cx, cy, hy } = p.s
    const laid = createMemo(() => layoutRadial(p.s))
    const rooms = keyedIds(() => laid().rooms, (room) => room.phase.id)
    return (
      <>
        <g data-hq-floor="">
          <For each={[[470, "2 10", 0.5], [350, "none", 0.35], [250, "none", 0.25]] as Array<[number, string, number]>}>
            {([r, da, op]) => (
              <ellipse cx={cx} cy={cy + 14} rx={r} ry={r * 0.34} fill="none" stroke={v("--hq-line-2")} stroke-opacity={op} stroke-dasharray={da} />
            )}
          </For>
          <For each={p.s.spokes}>{(l) => <line {...l} stroke={v("--hq-line-2")} stroke-opacity={0.18} />}</For>
          <For each={laid().rooms}>
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
          <ellipse class="hq-orbit-dash" data-hq-orbit="" cx={cx} cy={cy + 14} rx={218} ry={72} fill="none" stroke={v("--hq-glow")} stroke-opacity={0.55} stroke-dasharray="3 9" />
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
                <line x1={laid().beacon.x} y1={laid().beacon.lineTop} x2={laid().beacon.x} y2={laid().beacon.lineBottom} stroke={v("--hq-review")} stroke-dasharray="2 4" data-hq-beacon-line="" />
                <Beacon x={laid().beacon.x} y={laid().beacon.y} anchor="middle" max={220} text={language.t("session.mission.decision.beacon", { id: d().id })} />
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
                        {(spot) => <Agent rowId={spot().rowId} x={spot().x} y={spot().y} s={spot().s} label={(spot() as HqSpot).label} />}
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
    const lanes = keyedIds(() => layoutLanes(p.s).lanes, (lane) => lane.phase.id)
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
            {(d) => (
              // right edge where the old 106 px pill ended; it may grow left up to the "3/7" count (ends near x 220)
              <Beacon x={W - 22} y={46} anchor="end" max={W - 22 - 228} text={language.t("session.mission.decision.beacon", { id: d().id })} />
            )}
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
                        {(spot) => <Agent rowId={spot().rowId} x={spot().x} y={spot().y} s={spot().s} />}
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
