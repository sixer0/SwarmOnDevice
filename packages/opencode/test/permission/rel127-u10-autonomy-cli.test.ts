// 1.2.7 U-10 (decision C63, D-10b): `swarm autonomy …` from an agent's shell is refused, X `own_api` with reason
// `person_only`, by any spelling of the program (swarm, swarm-launcher, a path to the binary, a variable, `sh -c`, a
// pseudo terminal wrapper or interpreter code). Only the person turns the mode on (1.1.1 rule). No listener is needed:
// the command finds the server itself.
import { afterEach, expect, test } from "bun:test"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OWN_API_PERSON_ONLY_TEXT } from "../../src/permission/autonomy-texts"
import { refusedUnderConsent } from "../../src/permission"
import type { InstanceContext } from "../../src/project/instance-context"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const REFUSED = [
  "swarm autonomy on",
  "swarm autonomy off",
  "swarm autonomy status --session ses_1",
  "swarm --print-logs autonomy on",
  "swarm-launcher autonomy on",
  "/Applications/Swarm.app/Contents/Resources/swarm-launcher.sh autonomy on",
  "~/.local/bin/swarm autonomy on",
  "./node_modules/.bin/opencode autonomy on",
  "env SWARM_APP_STATE_HOME=/x swarm autonomy on",
  "echo yes | swarm autonomy on",
  "cd /tmp && swarm autonomy on",
  "sh -c 'swarm autonomy on'",
  `bash -lc "swarm 'autonomy' on"`,
  "eval swarm autonomy on",
  "B=swarm; $B autonomy on",
  '"$SWARM_BIN" autonomy on',
  '"$(command -v swarm)" autonomy on',
  "script -q /dev/null swarm autonomy on",
  "expect -c 'spawn swarm autonomy on; expect Type; send yes\\r; interact'",
  `python3 -c "import pty; pty.spawn(['swarm', 'autonomy', 'on'])"`,
  "bun run packages/opencode/src/index.ts autonomy on",
]

const NOT_THIS_RULE = [
  "swarm run 'say hi'",
  "swarm trust",
  "cat /repo/swarm/packages/opencode/src/cli/cmd/autonomy.ts",
  "grep -rn autonomy swarm.log",
  `git commit -m "feat: swarm autonomy command"`,
  "ls swarm/autonomy",
]

test("an agent's shell running swarm autonomy, by any spelling, is X own_api with the person-only text", async () => {
  await using fixture = await tmpdir({ git: true })
  const instance = { directory: fixture.path, worktree: fixture.path, project: { vcs: "git" } } as InstanceContext
  const input = (command: string): AutonomyTable.Input => ({
    permission: "bash",
    patterns: [command],
    metadata: { command },
    instance,
    cwd: fixture.path,
    canUndo: true,
    folder: "clean",
    bypass: { caller: "root" },
  })
  for (const command of REFUSED)
    expect({ command, verdict: AutonomyTable.classify(input(command)) }).toEqual({
      command,
      verdict: { class: "X", decidedBy: "gate", category: "own_api", reason: "person_only" },
    })
  for (const command of NOT_THIS_RULE)
    expect({ command, reason: AutonomyTable.classify(input(command)).reason }).toEqual({ command, reason: undefined })
  // The refusal names the rule, so the agent knows nobody can answer it for the person.
  expect(refusedUnderConsent("own_api", "person_only").message).toBe(OWN_API_PERSON_ONLY_TEXT)
  expect(OWN_API_PERSON_ONLY_TEXT).toContain("Only the person turns autonomous mode on")
})
