// Swarm 1.2.8 row 26 (R-1, AC-R1, N8-310): `autonomy-table.ts` is split into the eleven files of `autonomy-parts/` and
// stays as a barrel that re-exports exactly the names it exported before the split. The export lists below were captured
// at BASE e1f9673772 with `Object.keys(await import(...))`; the structure test is red at BASE (no `autonomy-parts/`).
// Pure: reads two source paths, nothing runs, no file is written.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { AutonomyTable } from "../../src/permission/autonomy-table"

const PERMISSION = path.join(import.meta.dir, "../../src/permission")
const PARTS = [
  "types",
  "routine",
  "read-class",
  "own-api",
  "shell-steps",
  "outside",
  "outward",
  "checkpoint",
  "subagent",
  "destroys",
  "consent",
]

// Captured at BASE e1f9673772. The module and the self re-exported `AutonomyTable` namespace carry the same names.
const BASE_NAMES = [
  "AutonomyTable",
  "CHECK_CLASS",
  "HARD_SCRIPT_FLAGS",
  "KEPT_D",
  "OUTPUT_FOLDERS",
  "OUTWARD_HELD",
  "READ_SHELL_COMMANDS",
  "READ_SHELL_ROLES",
  "SUBAGENT_RUNS_LIKE_ROOT",
  "TRUST_PERMISSION",
  "callsOwnServer",
  "checkpointPlan",
  "classify",
  "classifyBase",
  "commandWords",
  "consentOutward",
  "consentPush",
  "consentPushTarget",
  "consentRefusedPush",
  "destinationsOf",
  "isReadOnlyShell",
  "lockfileUnchanged",
  "netOptions",
  "noRepositoryBetween",
  "noWait",
  "outsideKind",
  "personOnlyRoute",
  "protectedOutside",
  "pushTarget",
  "readRoleRefuses",
  "replacingTargets",
  "routine",
  "searchedStateFolders",
  "shellReading",
  "spelling",
  "subagentSendsAnyway",
  "underConsent",
]

// The exported types at BASE. A missing one fails `bun run typecheck`, not this run.
export type BaseTypes = [
  AutonomyTable.Class,
  AutonomyTable.CheckClass,
  AutonomyTable.RoutineCategory,
  AutonomyTable.CommandKind,
  AutonomyTable.AllowedCategory,
  AutonomyTable.HeldCategory,
  AutonomyTable.EditClass,
  AutonomyTable.Verdict,
  AutonomyTable.Outward,
  AutonomyTable.Input,
  AutonomyTable.Consent,
  AutonomyTable.CheckpointPlan,
  AutonomyTable.CheckpointInput,
]

describe("R-1 AC-R1: the autonomy table split keeps its exports", () => {
  test("the module exports the BASE names, no more and no fewer", async () => {
    const mod = await import("../../src/permission/autonomy-table")
    expect(Object.keys(mod).sort()).toEqual(BASE_NAMES)
  })

  test("the AutonomyTable namespace carries the BASE names and the same bindings", async () => {
    const mod = await import("../../src/permission/autonomy-table")
    expect(Object.keys(mod.AutonomyTable).sort()).toEqual(BASE_NAMES)
    for (const name of BASE_NAMES)
      expect((mod.AutonomyTable as Record<string, unknown>)[name]).toBe((mod as Record<string, unknown>)[name])
  })

  test("the code lives in the eleven autonomy-parts files and the table is a barrel", () => {
    for (const part of PARTS) expect(fs.existsSync(path.join(PERMISSION, "autonomy-parts", part + ".ts"))).toBe(true)
    expect(fs.readdirSync(path.join(PERMISSION, "autonomy-parts")).sort()).toEqual(PARTS.map((p) => p + ".ts").sort())
    const barrel = fs.readFileSync(path.join(PERMISSION, "autonomy-table.ts"), "utf8")
    expect(barrel.split("\n").length).toBeLessThanOrEqual(200)
    const code = barrel
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
    expect(code).toContain('export * as AutonomyTable from "./autonomy-table"')
    // Only re-export statements: nothing is left once they are removed, so no function body or value lives here.
    const rest = code
      .replace(/export (type )?\{[^}]*\} from "\.\/autonomy-parts\/[a-z-]+"/g, "")
      .replace('export * as AutonomyTable from "./autonomy-table"', "")
    expect(rest.trim()).toBe("")
  })
})
