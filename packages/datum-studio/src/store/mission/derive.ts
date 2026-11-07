/**
 * Derived mission data (spec §4.3): waves and ready rows are computed on read and never stored.
 * - B (build) dependency: the row may start only when the dependency is `done`.
 * - C (contract) dependency: never blocks the start, and does not count for waves.
 * - Wave: no B dependency -> 1; else 1 + the highest wave among its B dependencies. Dropped rows are left out.
 * - Ready: `pending` rows whose B dependencies are all `done` (and, C57, no open decision request blocks them).
 */
import type { RowStatus, StatusCounts } from "./types.ts"

export interface GraphRow {
  id: string
  status: RowStatus
}

export interface DepEdge {
  row: string
  dep: string
  kind: "B" | "C"
}

export function parseDep(d: string): { row: string; kind: "B" | "C" } {
  const i = d.lastIndexOf(":")
  return { row: d.slice(0, i), kind: d.slice(i + 1) as "B" | "C" }
}

export function emptyCounts(): StatusCounts {
  return { pending: 0, running: 0, "needs-review": 0, blocked: 0, done: 0, dropped: 0 }
}

export function countStatuses(rows: readonly GraphRow[]): StatusCounts {
  const c = emptyCounts()
  for (const r of rows) c[r.status]++
  return c
}

function bDepsOf(deps: readonly DepEdge[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const d of deps) {
    if (d.kind !== "B") continue
    const list = m.get(d.row) ?? []
    list.push(d.dep)
    m.set(d.row, list)
  }
  return m
}

/** One B cycle as a path [a, b, ..., a], or null. Rows in input order, so the result is deterministic. */
export function findBCycle(rows: readonly GraphRow[], deps: readonly DepEdge[]): string[] | null {
  const b = bDepsOf(deps)
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const s = state.get(id)
    if (s === 2) return null
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 1)
    stack.push(id)
    for (const d of b.get(id) ?? []) {
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const r of rows) {
    const c = visit(r.id)
    if (c) return c
  }
  return null
}

/** Waves in row order inside each wave. Assumes no B cycle (checked on every write). */
export function computeWaves(rows: readonly GraphRow[], deps: readonly DepEdge[]): Array<{ wave: number; rows: string[] }> {
  const live = new Map(rows.filter((r) => r.status !== "dropped").map((r) => [r.id, r]))
  const b = bDepsOf(deps)
  const memo = new Map<string, number>()
  const waveOf = (id: string, guard: Set<string>): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    if (guard.has(id)) return 1
    guard.add(id)
    let w = 1
    for (const d of b.get(id) ?? []) if (live.has(d)) w = Math.max(w, waveOf(d, guard) + 1)
    guard.delete(id)
    memo.set(id, w)
    return w
  }
  const byWave = new Map<number, string[]>()
  for (const id of live.keys()) {
    const w = waveOf(id, new Set())
    const list = byWave.get(w) ?? []
    list.push(id)
    byWave.set(w, list)
  }
  return [...byWave.keys()].sort((a, c) => a - c).map((w) => ({ wave: w, rows: byWave.get(w)! }))
}

/** B dependencies of `rowId` that are not `done`. */
export function openBDeps(rowId: string, rows: readonly GraphRow[], deps: readonly DepEdge[]): string[] {
  const status = new Map(rows.map((r) => [r.id, r.status]))
  return deps.filter((d) => d.row === rowId && d.kind === "B" && status.get(d.dep) !== "done").map((d) => d.dep)
}

export function readyRows(rows: readonly GraphRow[], deps: readonly DepEdge[], blockedByRequest: ReadonlySet<string> = new Set()): string[] {
  return rows.filter((r) => r.status === "pending" && !blockedByRequest.has(r.id) && openBDeps(r.id, rows, deps).length === 0).map((r) => r.id)
}
