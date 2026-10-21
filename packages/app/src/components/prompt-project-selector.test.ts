import { describe, expect, mock, test } from "bun:test"
import type { PromptProject, PromptProjectControls } from "./prompt-project-selector"

// The project selector resolves the composer's current directory (server-reported spelling) against
// client-stored projects; the row-161 experiment proved those two spellings of one macOS directory
// diverge under raw pathKey. Language context is stubbed with the pattern submit.test.ts:272 uses —
// the controller only needs `t` for label strings, never for the comparison under test.
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const { createPromptProjectController } = await import("./prompt-project-selector")

const STORED = "/var/folders/sy/nt4h2c8t/kilo/r173b/home/.cache"
const RESOLVED = `/private${STORED}`

const controls = (input: Partial<PromptProjectControls> = {}): PromptProjectControls => ({
  available: [],
  directory: "",
  server: undefined,
  select: () => {},
  add: () => {},
  ...input,
})

const project = (worktree: string, sandboxes?: string[]): PromptProject => ({
  worktree,
  ...(sandboxes ? { sandboxes } : {}),
})

const controller = (input: PromptProjectControls) =>
  createPromptProjectController({ controls: () => input, onDone: () => {} })

describe("prompt project selector current() across the two /private spellings", () => {
  test("a /private-resolved composer directory selects the stored /var project even when it is not first", () => {
    const available = [project("/Users/dev/other"), project(STORED)]
    const c = controller(controls({ directory: RESOLVED, available }))
    expect(c.selected()?.worktree).toBe(STORED)
  })

  test("the opposite direction: stored /var directory selects a /private project", () => {
    const available = [project("/Users/dev/other"), project(RESOLVED)]
    const c = controller(controls({ directory: STORED, available }))
    expect(c.selected()?.worktree).toBe(RESOLVED)
  })

  test("sandbox spellings fold too", () => {
    const sandbox = `${STORED}/worktrees/feat`
    const available = [project("/Users/dev/other"), project(STORED, [sandbox])]
    const c = controller(controls({ directory: `/private${sandbox}`, available }))
    expect(c.selected()?.worktree).toBe(STORED)
  })

  test("no-op control: identical spellings still select", () => {
    const available = [project("/Users/dev/other"), project(STORED)]
    expect(controller(controls({ directory: STORED, available })).selected()?.worktree).toBe(STORED)
  })

  test("negative control: an unrelated directory falls back to the first project", () => {
    const available = [project("/Users/dev/first"), project(STORED)]
    expect(controller(controls({ directory: "/Users/dev/unlisted", available })).selected()?.worktree).toBe(
      "/Users/dev/first",
    )
  })

  test("scope control: /private/opt does not fold onto /opt", () => {
    const available = [project("/Users/dev/other"), project("/opt/data")]
    expect(controller(controls({ directory: "/private/opt/data", available })).selected()?.worktree).toBe(
      "/Users/dev/other",
    )
  })
})
