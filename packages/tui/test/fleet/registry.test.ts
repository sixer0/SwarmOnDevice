import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { jumpToRow, publish, readPeers, requestGoto, takeGoto, tmuxContext, unpublish } from "../../src/fleet/registry"
import type { FleetEntry, FleetRow } from "../../src/fleet/model"

let dir: string
const NOW = 1_800_000_000_000
const entry = (pid: number, over: Partial<FleetEntry> = {}): FleetEntry => ({
  version: 1,
  pid,
  host: "h",
  directory: "/work",
  updated: NOW,
  agents: [],
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a published entry is private to the user and readable by another process", () => {
  publish(dir, entry(process.pid))
  expect(statSync(path.join(dir, `${process.pid}.json`)).mode & 0o777).toBe(0o600)
  expect(readPeers(dir, { now: NOW, host: "h" }).map((peer) => peer.pid)).toEqual([process.pid])
})

test("a process does not list itself", () => {
  publish(dir, entry(process.pid))
  expect(readPeers(dir, { self: process.pid, now: NOW, host: "h" })).toEqual([])
})

test("files from dead processes are removed; unreadable ones too", () => {
  const dead = Bun.spawnSync(["true"]).pid
  publish(dir, entry(dead))
  writeFileSync(path.join(dir, `${process.pid}.json`), "{not json")
  expect(readPeers(dir, { now: NOW, host: "h" })).toEqual([])
  expect(existsSync(path.join(dir, `${dead}.json`))).toBe(false)
  expect(existsSync(path.join(dir, `${process.pid}.json`))).toBe(false)
})

test("a live process that has gone quiet is hidden but its file stays, so it reappears on resume", () => {
  publish(dir, entry(process.pid, { updated: NOW - 60_000 }))
  expect(readPeers(dir, { now: NOW, host: "h" })).toEqual([])
  expect(existsSync(path.join(dir, `${process.pid}.json`))).toBe(true)
})

test("another host's files on a shared home are ignored and left alone", () => {
  publish(dir, entry(1, { host: "other" }))
  expect(readPeers(dir, { now: NOW, host: "h" })).toEqual([])
  expect(existsSync(path.join(dir, "1.json"))).toBe(true)
})

test("a missing directory reads as no peers", () => {
  expect(readPeers(path.join(dir, "nope"), { now: NOW })).toEqual([])
})

test("a goto is consumed once, and unpublish clears everything", () => {
  requestGoto(dir, 5, "ses_1")
  expect(takeGoto(dir, 5)).toBe("ses_1")
  expect(takeGoto(dir, 5)).toBeUndefined()
  publish(dir, entry(5))
  requestGoto(dir, 5, "ses_2")
  unpublish(dir, 5)
  expect(existsSync(path.join(dir, "5.json"))).toBe(false)
  expect(existsSync(path.join(dir, "5.goto"))).toBe(false)
})

test("tmux context needs both the socket and the pane", () => {
  expect(tmuxContext({ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" })).toEqual({
    socket: "/tmp/tmux-501/default",
    pane: "%7",
  })
  expect(tmuxContext({ TMUX_PANE: "%7" })).toBeUndefined()
  expect(tmuxContext({ TMUX: "/tmp/x,1,0" })).toBeUndefined()
})

const row = (where: FleetRow["where"]): FleetRow => ({
  key: "k",
  sessionID: "ses_9",
  title: "t",
  directory: "/work",
  state: "waiting",
  since: NOW,
  tail: [],
  where,
})

test("rows that cannot be reached say where the agent is instead of failing silently", () => {
  expect(jumpToRow(dir, row({ kind: "peer", pid: 4, otherTmux: true }))).toEqual({
    ok: false,
    message: "That agent is in a tmux session this terminal is not part of (pid 4). Switch to it there.",
  })
  expect(jumpToRow(dir, row({ kind: "peer", pid: 4, otherTmux: false }))).toEqual({
    ok: false,
    message: "That agent is in a terminal outside tmux (pid 4). Switch to it there.",
  })
})

test("a jump runs tmux with the pane, then asks that Swarm to show the session; a tmux failure is reported", () => {
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  const shim = path.join(bin, "tmux")
  const log = path.join(dir, "argv")
  writeFileSync(shim, `#!/bin/sh\nprintf '%s ' "$@" > "${log}"\nexit \${TMUX_SHIM_EXIT:-0}\n`)
  chmodSync(shim, 0o755)
  const saved = { PATH: process.env.PATH, TMUX_SHIM_EXIT: process.env.TMUX_SHIM_EXIT }
  process.env.PATH = `${bin}:${saved.PATH}`
  try {
    expect(jumpToRow(dir, row({ kind: "peer", pid: 4, pane: "%12", otherTmux: false }))).toEqual({ ok: true })
    expect(readFileSync(log, "utf8").trim()).toBe("switch-client -t %12")
    expect(takeGoto(dir, 4)).toBe("ses_9")
    process.env.TMUX_SHIM_EXIT = "1"
    expect(jumpToRow(dir, row({ kind: "peer", pid: 4, pane: "%12", otherTmux: false })).ok).toBe(false)
    expect(takeGoto(dir, 4)).toBeUndefined()
  } finally {
    process.env.PATH = saved.PATH
    delete process.env.TMUX_SHIM_EXIT
  }
})
