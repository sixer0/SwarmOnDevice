// The mission control channels (row 127; masterplan/01_specs_mission_control_ui.md §3.1). Both the preload and main
// import this file, so a renamed or mistyped channel fails typecheck. It has no imports, which keeps it safe for the
// sandboxed preload bundle.
export const MISSION_CONTROL_IPC = {
  list: "mission-control:list",
  get: "mission-control:get",
  answer: "mission-control:answer",
  instruct: "mission-control:instruct",
} as const
