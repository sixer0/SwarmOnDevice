// Which swarm-setup components are healthy on this machine, for the `<installed_tools>` prompt block (U14b).
//
// The source is the component record swarm-setup commits at ~/.swarm/setup/state.json (PC-PATH-02); the shape is
// owned by packages/setup/src/state.ts (`components.<id>.state`, values PC-ST-*). opencode does not import
// @swarm/setup (row 194 C-207-i: swarm/AGENTS.md dependency direction), so the setup vocabulary opencode needs is
// restated here once: the component ids, the two MCP keys and the state.json location. server/shared/
// setup-observation.ts imports them from this module (senior review 239 finding 6); the one drift test against
// packages/setup/src/constants.ts is in test/session/installed-tools.test.ts.
//
// The answer is a list of register ids and nothing else. Every id comes from COMPONENT_IDS below, never from the
// file, so no string in the state file can reach the prompt. A file that is missing, unreadable, not JSON, not an
// object, not a regular file or larger than MAX_STATE_BYTES gives an empty list: the prompt then names no tool.
//
// The packaged app runs this server on Node (test/runtime/node-sidecar.test.ts), so only node:fs is used here.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"

/** Register vocabulary PC-CMP-01..07, in register order (packages/setup/src/constants.ts:9-17). */
export const COMPONENT_IDS = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"] as const

export type ComponentId = (typeof COMPONENT_IDS)[number]

/** Keys under `mcp` in swarm.json: PC-MCP-01 graft and PC-MCP-02 swarm-web (packages/setup/src/mcpproxy/register.ts:9). */
export const GRAFT_MCP = "graft"
export const SWARM_WEB_MCP = "swarm-web"

/** PC-ST-06 (packages/setup/src/constants.ts:33). */
const HEALTHY = "healthy"

/** A real record is a few KiB; anything past this is not read. */
export const MAX_STATE_BYTES = 256 * 1024

/** Why the list came back empty. `missing` is the normal never-set-up case and is not logged. */
export type Problem = "missing" | "unreadable" | "not_a_file" | "too_large" | "not_json" | "not_an_object"

/** PC-PATH-02 under a given home. Callers choose the home: this module honours the test home, the route does not. */
export function stateFileUnder(home: string): string {
  return path.join(home, ".swarm", "setup", "state.json")
}

/** The writer resolves HOME, else os.homedir() (packages/setup/src/paths.ts:12-15). OPENCODE_TEST_HOME is only set by
 *  the test preload, and honouring it keeps a developer's real state file out of every test prompt. */
export function stateFilePath(): string {
  const test = process.env.OPENCODE_TEST_HOME
  const home =
    test && test.length > 0 ? test : process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : os.homedir()
  return stateFileUnder(home)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Reads at most MAX_STATE_BYTES + 1 bytes from an open descriptor, so a file that grows after fstat is still caught. */
function readBounded(fd: number): string | undefined {
  const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
  let filled = 0
  while (filled < buffer.length) {
    const read = readSync(fd, buffer, filled, buffer.length - filled, null)
    if (read === 0) break
    filled += read
  }
  if (filled > MAX_STATE_BYTES) return undefined
  return buffer.subarray(0, filled).toString("utf8")
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

type Text = { readonly text: string } | { readonly problem: Problem }

function closeQuietly(fd: number) {
  try {
    closeSync(fd)
  } catch {
    // The bytes are already in memory; a failed close changes nothing about the answer.
  }
}

function openState(file: string): { readonly fd: number } | { readonly problem: Problem } {
  try {
    return { fd: openSync(file, "r") }
  } catch (err) {
    return { problem: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }
  }
}

/** The file's text, bounded, through one descriptor so the checks and the read see the same file. */
function readText(file: string): Text {
  const opened = openState(file)
  if ("problem" in opened) return opened
  try {
    const stat = fstatSync(opened.fd)
    if (!stat.isFile()) return { problem: "not_a_file" }
    if (stat.size > MAX_STATE_BYTES) return { problem: "too_large" }
    const text = readBounded(opened.fd)
    return text === undefined ? { problem: "too_large" } : { text }
  } catch {
    return { problem: "unreadable" }
  } finally {
    closeQuietly(opened.fd)
  }
}

/** One fresh read, no cache. Ids are returned in register order, healthy ones only. */
export function read(file = stateFilePath()): { ids: ComponentId[]; problem?: Problem } {
  const loaded = readText(file)
  if ("problem" in loaded) return { ids: [], problem: loaded.problem }

  const parsed = decodeJson(loaded.text)
  if (Option.isNone(parsed)) return { ids: [], problem: "not_json" }
  if (!isRecord(parsed.value)) return { ids: [], problem: "not_an_object" }

  // Own properties only, at both levels (security review 238 F7): an inherited `components` or `components.<id>`
  // from a polluted Object.prototype must not name a tool. JSON.parse makes `__proto__` keys own properties, so a
  // hostile file cannot reach the prototype this way; the check closes the already-polluted-process case.
  const record = parsed.value
  const components = Object.hasOwn(record, "components") && isRecord(record.components) ? record.components : {}
  return {
    ids: COMPONENT_IDS.filter((id) => {
      const entry = Object.hasOwn(components, id) ? components[id] : undefined
      return isRecord(entry) && Object.hasOwn(entry, "state") && entry.state === HEALTHY
    }),
  }
}

/** The healthy ids, logging a warning (reason code only, no path or file text) when a present file could not be used. */
export const healthy = Effect.fn("InstalledTools.healthy")(function* (file?: string) {
  const result = read(file)
  if (result.problem !== undefined && result.problem !== "missing")
    yield* Effect.logWarning("swarm-setup state file ignored", { problem: result.problem })
  return result.ids
})

export * as InstalledTools from "./installed-tools"
