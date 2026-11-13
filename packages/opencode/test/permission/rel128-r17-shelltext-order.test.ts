// 1.2.8 row 28e (C76 FINDING routed to 28e). `shellTextCall` (autonomy-parts/subagent.ts) reads the text of
// `sh|bash|zsh -c '<literal>'` with the shell's own reader (`ScriptReader`, SR7-20), which starts asynchronously; the
// table is synchronous and answers "not read" (the 1.2.6 path) until the reader is ready. Row 28 saw the same input give
// two answers alone and with other test files: its file judged the table without the precondition the gate gives every
// consented call (`index.ts` waits for the reader before `judge`), so its first calls ran cold and, once a read had
// started the reader, later calls ran warm. Root cause pinned here, with the precondition taken as the gate takes it:
// - warm, the same inputs give the same verdict in either order and again, root and subagent alike;
// - cold, nothing is read for any input in either order (never a partial reading: a plain text is judged as one the
//   reader could not read), the same in either order; once the reader is ready the answer is the warm one.
// Synthetic values only; home is a fresh mkdtemp folder.
//
// Run targeted: cd packages/opencode && bun test test/permission/rel128-r17-shelltext-order.test.ts

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

const SELF = { hostname: "127.0.0.1", port: 47291 }
const OWN = `http://127.0.0.1:${SELF.port}`

let fixture: Awaited<ReturnType<typeof tmpdir>>
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []
beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  instance = { directory: fixture.path, worktree: fixture.path, project: { vcs: "git" } } as InstanceContext
  home = mkdtempSync(path.join(os.tmpdir(), "r17o-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  SelfAddress.add(SELF)
  // The gate's precondition (index.ts, SCRIPT_READER_WAIT): the reader is ready before a consented call is judged.
  await ScriptReader.prepare()
})
afterAll(async () => {
  SelfAddress.remove(SELF)
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

const COMMANDS = [
  `sh -c 'curl -s ${OWN}/session'`,
  `curl -s ${OWN}/session`,
  "sh -c 'curl -s https://example.com'",
  "sh -c 'ls'",
  "bash -c 'echo hi'",
  "zsh -c 'git push'",
  "emulate sh -c 'ls -la'",
  "sh -c 'rm -f x'",
  "sh -c 'echo $(id)'",
] as const
const CALLERS = ["root", "subagent"] as const

const input = (command: string, caller: (typeof CALLERS)[number]): AutonomyTable.Input => ({
  permission: "bash",
  patterns: [command],
  metadata: { command },
  instance,
  cwd: instance.directory,
  canUndo: true,
  folder: "clean",
  bypass: { caller },
})

/** Each (command, caller)'s verdict, judged in the order given. */
const judged = (order: readonly string[]) =>
  Object.fromEntries(
    order.flatMap((command) => CALLERS.map((caller) => [`${caller} ${command}`, AutonomyTable.classify(input(command, caller))])),
  )
test("warm: the same sh -c inputs give the same verdict in either order and again, root and subagent", () => {
  expect(ScriptReader.isReady()).toBe(true)
  const forward = judged(COMMANDS)
  const backward = judged([...COMMANDS].reverse())
  const again = judged(COMMANDS)
  expect(backward).toEqual(forward)
  expect(again).toEqual(forward)
  // The reader read the plain text (the gate runs `ls`) and left the substitution unread (the main agent decides).
  expect(forward[`subagent sh -c 'ls'`]).toEqual({ class: "A", decidedBy: "gate" })
  expect(forward[`root emulate sh -c 'ls -la'`]).toEqual({ class: "A", decidedBy: "gate" })
  expect(forward[`subagent sh -c 'echo $(id)'`]).toMatchObject({ category: "by_main_agent", bypassed: "unreadable_command" })
})

test("cold: nothing is read in either order; once the reader is ready the answer is the warm one", async () => {
  const warm = judged(COMMANDS)
  // A reader whose start never settles: cold for as long as this test runs, whatever another file did before.
  const restore = ScriptReader.testing.replace({ loader: () => new Promise<never>(() => {}) })
  try {
    expect(ScriptReader.isReady()).toBe(false)
    const forward = judged(COMMANDS)
    expect(judged([...COMMANDS].reverse())).toEqual(forward)
    // Nothing is read: a plain text is judged as one the reader could not read, never in part.
    expect(forward[`subagent sh -c 'ls'`]).toMatchObject({ category: "by_main_agent", bypassed: "unreadable_command" })
    expect(forward[`root emulate sh -c 'ls -la'`]).toEqual(forward[`root sh -c 'echo $(id)'`])
  } finally {
    restore()
  }
  await ScriptReader.prepare()
  expect(ScriptReader.isReady()).toBe(true)
  expect(judged([...COMMANDS].reverse())).toEqual(warm)
})
