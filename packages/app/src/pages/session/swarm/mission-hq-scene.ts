// HQ command deck geometry (row 130; masterplan/01_specs_mission_control_ui.md §5.3, §6 items 5-19, 38, 41).
// Pure: MissionVM + the stage width -> positions of rooms, conduits, agents and the deck. The geometry is ported from
// the master design report/mission_control_master.html (v6) `radial()` and `lanes()`; the view only draws it.

import type { DeliverableStatus, MissionAgentStatus, MissionAgentVM, MissionFamily, MissionPhaseVM, MissionVM } from "./mission-model"

/** Stage width at and above which the radial deck is drawn (V6:256 `wide()`; spec §5.3). */
export const RADIAL_MIN_WIDTH = 540

/** Theme map (§6 item 38): the master's tokens -> the app's v2 tokens (light/dark follow the app theme). The fallback
 * after the comma is the master's dark value, used only when a v2 token is missing. Robot shell and visor are a
 * material, not a theme colour, so they stay fixed as in the master (V6:15). */
export const HQ_TOKENS: Record<string, string> = {
  "--hq-stage": "var(--v2-background-bg-base, #0b161d)",
  "--hq-stage-2": "var(--v2-background-bg-layer-01, #0f1d26)",
  "--hq-card": "var(--v2-background-bg-layer-01, #13222b)",
  "--hq-card-2": "var(--v2-background-bg-layer-02, #182a34)",
  "--hq-line": "var(--v2-border-border-base, #203540)",
  "--hq-line-2": "var(--v2-border-border-strong, #2d4753)",
  "--hq-ink": "var(--v2-text-text-base, #e7eef1)",
  "--hq-ink-2": "var(--v2-text-text-muted, #a3b5bd)",
  "--hq-ink-3": "var(--v2-text-text-faint, #6f8690)",
  "--hq-glow": "var(--v2-text-text-accent, #7fe3ff)",
  "--hq-run": "var(--v2-state-fg-info, #58c7ec)",
  "--hq-review": "var(--v2-state-fg-warning, #f2b65a)",
  "--hq-issue": "var(--v2-state-fg-danger, #f07272)",
  // No v2 token for "blocked": the warning colour pulled towards muted text (V6 draws it as a darker amber).
  "--hq-blocked": "color-mix(in srgb, var(--v2-state-fg-warning, #e6a33e) 72%, var(--v2-text-text-muted, #a3b5bd))",
  "--hq-done": "var(--v2-state-fg-success, #72c494)",
  "--hq-wait": "var(--v2-text-text-faint, #5c6e77)",
  "--hq-f-plan": "var(--v2-agent-writer-solid, #b9aef0)",
  "--hq-f-research": "var(--v2-agent-review-solid, #a6e0c6)",
  "--hq-f-build": "var(--v2-agent-explore-solid, #ecbc85)",
  "--hq-f-verify": "var(--v2-agent-plan-solid, #e9b0d6)",
  "--hq-f-ship": "var(--v2-text-text-muted, #bcc6c1)",
  "--hq-shell": "#e9eff0",
  "--hq-shell-2": "#c7d2d5",
  "--hq-visor": "#0d1a20",
}

export const STATUS_COLOR: Record<MissionAgentStatus, string> = {
  running: "--hq-run",
  review: "--hq-review",
  issue: "--hq-issue",
  blocked: "--hq-blocked",
  done: "--hq-done",
  waiting: "--hq-wait",
}
export const STATUS_ORDER: MissionAgentStatus[] = ["running", "review", "issue", "blocked", "done", "waiting"]
export const DELIVERABLE_COLOR: Record<DeliverableStatus, string> = { draft: "--hq-ink-3", review: "--hq-review", final: "--hq-done" }
export const FAMILIES: MissionFamily[] = ["plan", "research", "build", "verify", "ship"]
export const familyColor = (family: MissionFamily) => `--hq-f-${family}`
export const cssVar = (name: string) => `var(${name})`

/** §5.4: row title cut to 12 characters + "…". */
export function agentLabel(title: string) {
  const chars = Array.from(title)
  return chars.length > 12 ? chars.slice(0, 12).join("") + "…" : title
}

/** §5.2: checkpoint bar fill 0..1. No checkpoint: done = full, otherwise empty. */
export function checkpointFill(agent: Pick<MissionAgentVM, "checkpoint" | "status">) {
  const cp = agent.checkpoint
  if (cp && cp.m > 0) return Math.max(0, Math.min(1, cp.n / cp.m))
  return agent.status === "done" ? 1 : 0
}

/** Radial only when the model allows it (4 or 5 phases) and the stage is wide enough (§5.3). */
export function hqMode(model: Pick<MissionVM, "layout" | "phases">, width: number): "radial" | "lanes" {
  const fits = model.phases.length === 4 || model.phases.length === 5
  return model.layout === "radial" && fits && width >= RADIAL_MIN_WIDTH ? "radial" : "lanes"
}

export type AgentSpot = { rowId: string; x: number; y: number; s: number }
export type RadialRoom = {
  phase: MissionPhaseVM
  x: number
  py: number // floor (tier) centre y
  rx: number
  ry: number
  ty: number // sign y
  signWidth: number
  dome: string
  conduit: { x1: number; y1: number; x2: number; y2: number }
  agents: AgentSpot[]
}
export type LaneRoom = { phase: MissionPhaseVM; y: number; h: number; agents: AgentSpot[] }

export type RadialScene = {
  mode: "radial"
  width: number
  height: number
  cx: number
  cy: number
  hy: number // hologram centre y
  rooms: RadialRoom[]
  spokes: Array<{ x1: number; y1: number; x2: number; y2: number }>
}
export type LanesScene = { mode: "lanes"; width: number; height: number; lanes: LaneRoom[] }
export type HqScene = RadialScene | LanesScene

const RADIAL_POS: Record<number, Array<[number, number]>> = {
  5: [
    [180, 175],
    [820, 175],
    [180, 478],
    [820, 478],
    [500, 590],
  ],
  4: [
    [195, 185],
    [805, 185],
    [195, 485],
    [805, 485],
  ],
}

/** V6:282-310: rooms around the deck, agents in rows of 2 (3 when a room holds more than 4). */
export function radialScene(model: MissionVM): RadialScene {
  const W = 1000
  const H = 668
  const cx = 500
  const cy = 338
  const pos = RADIAL_POS[model.phases.length] ?? RADIAL_POS[4]
  const spokes = Array.from({ length: 16 }, (_, k) => {
    const a = (k / 16) * Math.PI * 2
    return {
      x1: cx + Math.cos(a) * 215,
      y1: cy + 14 + Math.sin(a) * 73,
      x2: cx + Math.cos(a) * 470,
      y2: cy + 14 + Math.sin(a) * 160,
    }
  })
  const rooms = model.phases.slice(0, pos.length).map((phase, i): RadialRoom => {
    const [x0, y0] = pos[i]
    const n = phase.rows.length
    const per = n > 4 ? 3 : Math.max(1, Math.min(n, 2))
    const lines = Math.ceil(n / per) || 1
    const s = lines > 1 ? 0.66 : 0.8
    const dx = lines > 1 ? 94 : 96
    const dy = 118 * s + 30
    const w = Math.max(210, per * dx + 64)
    const rx = w / 2
    const ry = 30 + (lines - 1) * 6
    const top = y0 - ((lines - 1) * dy) / 2
    const py = top + (lines - 1) * dy + 18
    const ty = top - 104 * s - 30
    const vx = x0 - cx
    const vy = py - (cy + 14)
    const t = 1 / Math.hypot(vx / 192, vy / 60)
    const agents = phase.rows.map((rowId, j) => {
      const col = j % per
      const ln = Math.floor(j / per)
      const inl = Math.min(per, n - ln * per)
      return { rowId, x: x0 + (col - (inl - 1) / 2) * dx, y: top + ln * dy, s }
    })
    return {
      phase,
      x: x0,
      py,
      rx,
      ry,
      ty,
      signWidth: Math.max(132, phase.name.length * 9.5 + 70),
      dome: `M${x0 - rx + 10} ${py} A${rx - 10} ${py - ty + 4} 0 0 1 ${x0 + rx - 10} ${py}`,
      conduit: { x1: cx + vx * t, y1: cy + 14 + vy * t, x2: x0 - vx * 0.18, y2: py - vy * 0.12 },
      agents,
    }
  })
  return { mode: "radial", width: W, height: H, cx, cy, hy: cy - 134, rooms, spokes }
}

/** V6:339-360: a compact deck strip on top, then one lane per phase with up to 4 agents per line. */
export function lanesScene(model: MissionVM): LanesScene {
  const W = 400
  const per = 4
  let y = 94
  const lanes = model.phases.map((phase): LaneRoom => {
    const l = Math.max(1, Math.ceil(phase.rows.length / per))
    const h = 14 + l * 82
    const lane = {
      phase,
      y,
      h,
      agents: phase.rows.map((rowId, j) => ({ rowId, x: 62 + (j % per) * 92, y: y + 78 + Math.floor(j / per) * 82, s: 0.56 })),
    }
    y += 26 + l * 82
    return lane
  })
  return { mode: "lanes", width: W, height: y + 30, lanes }
}

export function hqScene(model: MissionVM, width: number): HqScene {
  return hqMode(model, width) === "radial" ? radialScene(model) : lanesScene(model)
}
