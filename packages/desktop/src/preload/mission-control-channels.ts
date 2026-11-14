// The mission control channels (row 127; masterplan/01_specs_mission_control_ui.md §3.1). Both the preload and main
// import this file, so a renamed or mistyped channel fails typecheck. It has no imports, which keeps it safe for the
// sandboxed preload bundle.
export const MISSION_CONTROL_IPC = {
  list: "mission-control:list",
  get: "mission-control:get",
  answer: "mission-control:answer",
  instruct: "mission-control:instruct",
  // 1.2.8 row 46 (N8-144, 01d §7): the person's join/new click on an open placement request; main answers, moves and
  // places in one sequence (mission-ipc.ts placeMission).
  place: "mission-control:place",
} as const
