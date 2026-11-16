// Pane performance marks (REG §8.5 rev 3, TS-RC-3, D9 of C22). No UI control is added
// (AC-46). The API layer marks `request` and `firstText`; the shell marks `send` (Send
// click) and `busy` (busy indicator shown) with the same marker.
import {
  OFFICE_PERF_MARK_BUSY,
  OFFICE_PERF_MARK_FIRST_TEXT,
  OFFICE_PERF_MARK_REQUEST,
  OFFICE_PERF_MARK_SEND,
} from "../constants"

const OFFICE_PERF_MARKS = [
  OFFICE_PERF_MARK_SEND,
  OFFICE_PERF_MARK_REQUEST,
  OFFICE_PERF_MARK_FIRST_TEXT,
  OFFICE_PERF_MARK_BUSY,
] as const

export type PerfMarkName = (typeof OFFICE_PERF_MARKS)[number]

export type Marker = (name: PerfMarkName) => void

// A missing or failing Performance API never breaks a send.
export function performanceMarker(perf: Pick<Performance, "mark"> | undefined = globalThis.performance): Marker {
  return (name) => {
    if (!perf) return
    // Synchronous on purpose: the mark time is the measurement.
    try {
      perf.mark(name)
    } catch {
      return
    }
  }
}
