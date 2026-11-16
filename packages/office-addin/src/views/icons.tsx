// Pane icons (design §2 "Mark", mockup symbols). Decorative: always aria-hidden; the control
// that holds one carries the accessible name.
const HEX =
  "M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"

const CELLS: [number, number, number][] = [
  [512, 512, 1],
  [678.28, 512, 1],
  [595.14, 368, 1],
  [428.86, 368, 1],
  [345.72, 512, 1],
  [428.86, 656, 1],
  [595.14, 656, 1],
  [842, 267, 0.55],
  [182, 757, 0.55],
]

// The 9-cell hexagon mark of packages/ui `Mark`, single tone `currentColor`.
export function Mark(props: { class?: string }) {
  return (
    <svg class={props.class ?? "mark"} viewBox="0 0 16 20" aria-hidden="true">
      <g fill="currentColor" transform="translate(8 10) scale(0.019961) translate(-512 -512)">
        {CELLS.map(([x, y, s]) => (
          <path d={HEX} transform={`translate(${x} ${y}) scale(${s})`} />
        ))}
      </g>
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}

export function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5 14 13H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <path d="M8 6.5v3M8 11.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  )
}

export function OffIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M4.2 11.8 11.8 4.2" stroke="currentColor" stroke-width="1.4" />
    </svg>
  )
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4" />
    </svg>
  )
}
