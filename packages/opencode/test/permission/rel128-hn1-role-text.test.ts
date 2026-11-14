import { expect, test } from "bun:test"
import { ROLE_SHELL_OUTSIDE_READ_TEXT } from "../../src/permission/autonomy-texts"
import { RoleShellRefusedError } from "../../src/permission"
import * as Task from "../../src/tool/task"

// 1.2.8 AC-HN1 (N8-316, H-N1, wording N8-391): a read role's refusal no longer sends the agent to a "coder subagent",
// which a subagent cannot start (it cannot delegate). Both texts say the command was not run and that the agent lists it
// in its final message, so the agent that started it, or the person, can run it.

const ROLE_TEXT =
  "This agent role only runs inspection commands (for example ls, head, git log). This command was not run: list it in your final message so the agent that started you, or the person, can run it."

test("N8-391: the read-role shell refusal names a route a subagent can take", () => {
  expect(ROLE_SHELL_OUTSIDE_READ_TEXT).toBe(ROLE_TEXT)
  expect(ROLE_SHELL_OUTSIDE_READ_TEXT).not.toContain("coder subagent")
})

test("N8-391: RoleShellRefusedError still selects the constant", () => {
  expect(new RoleShellRefusedError({ ruleset: [] }).message).toBe(ROLE_SHELL_OUTSIDE_READ_TEXT)
})

test("N8-391: the task grant refusal for a read role asks for the command in the final message", () => {
  for (const role of ["planner", "data-collector"]) {
    const text = Task.taskGrantRefusal({ patterns: ["bun test"], role, parent: [], child: [] })
    expect(text).toBe(
      `${Task.TASK_GRANT_ROLE_DENIED} Task not started: the ${role} role may not run "bun test". Ask for it in your final message instead.`,
    )
    expect(text).not.toContain("coder subagent")
  }
})
