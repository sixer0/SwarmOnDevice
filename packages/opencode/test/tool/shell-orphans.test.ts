import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ShellOrphans } from "../../src/tool/shell/orphans"

const groups: number[] = []

afterEach(() => {
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
})

const session = () => `ses_orphan_${Math.random().toString(36).slice(2)}`

// A real group, as the shell tool starts one: the shell leads it and has a child of its own.
const command = (script: string) => {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" })
  child.unref()
  groups.push(child.pid!)
  return child.pid!
}

const alive = (pid: number) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const started = (pid: number) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()

const deadServer = async () => {
  const server = spawn("true")
  await new Promise((resolve) => server.once("exit", resolve))
  return { pid: server.pid!, started: "Thu Jan  1 00:00:00 1970" }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
}

describe("ShellOrphans", () => {
  test("ends the whole group of a command whose server died", async () => {
    const id = session()
    const pid = command("sleep 30 & wait")
    ShellOrphans.record(id, pid, await deadServer())
    expect(await ShellOrphans.end(id)).toBe(1)
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
    expect(await ShellOrphans.end(id)).toBe(0)
  })

  test("a command that ignores the polite signal is still stopped", async () => {
    const id = session()
    const pid = command("trap '' TERM; while true; do sleep 0.05; done")
    await Bun.sleep(100)
    ShellOrphans.record(id, pid, await deadServer())
    expect(await ShellOrphans.end(id)).toBe(1)
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })

  test("leaves a command alone while its server is up", async () => {
    const id = session()
    const pid = command("sleep 30")
    ShellOrphans.record(id, pid)
    expect(await ShellOrphans.end(id)).toBe(0)
    expect(alive(pid)).toBe(true)
    ShellOrphans.record(id, pid, { pid: process.pid, started: started(process.pid) })
    expect(await ShellOrphans.end(id)).toBe(0)
    expect(alive(pid)).toBe(true)
  })

  test("a finished command leaves nothing to end", async () => {
    const id = session()
    const pid = command("sleep 30")
    ShellOrphans.record(id, pid, await deadServer())
    ShellOrphans.clear(id, pid)
    expect(await ShellOrphans.end(id)).toBe(0)
    expect(alive(pid)).toBe(true)
  })

  test("does not touch a new process that was given the same number", async () => {
    const id = session()
    const pid = command("sleep 30")
    await waitFor(() => started(pid) !== "")
    ShellOrphans.record(id, pid, await deadServer())
    const file = `${(await import("@opencode-ai/core/global")).Global.Path.state}/shell-running/${id}/${pid}.json`
    const entry = await Bun.file(file).json()
    await Bun.write(file, JSON.stringify({ ...entry, started: "Thu Jan  1 00:00:00 1970" }))
    expect(await ShellOrphans.end(id)).toBe(0)
    expect(alive(pid)).toBe(true)
  })

  test("another session's command is not this session's to end", async () => {
    const pid = command("sleep 30")
    ShellOrphans.record(session(), pid, await deadServer())
    expect(await ShellOrphans.end(session())).toBe(0)
    expect(alive(pid)).toBe(true)
  })

  describe("when ps cannot answer", () => {
    // What BusyBox's does with `-p`: fails, and says so. `kill` is the shell's own, so only `ps` is affected.
    const withoutPs = async <T>(run: () => Promise<T>) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "no-ps-"))
      writeFileSync(path.join(dir, "ps"), "#!/bin/sh\necho 'ps: unrecognized option: p' >&2\nexit 1\n", { mode: 0o755 })
      const before = process.env.PATH
      process.env.PATH = dir
      try {
        return await run()
      } finally {
        process.env.PATH = before
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test("a command under a live server is never killed", async () => {
      const id = session()
      const pid = command("sleep 30")
      await waitFor(() => started(pid) !== "")
      ShellOrphans.record(id, pid, { pid: process.pid, started: started(process.pid) })
      expect(await withoutPs(() => ShellOrphans.end(id))).toBe(0)
      expect(alive(pid)).toBe(true)
      // The record is kept, for a later call that can tell.
      ShellOrphans.clear(id, pid)
    })

    test("nor when it could not answer at the start either", async () => {
      const id = session()
      const pid = command("sleep 30")
      await withoutPs(async () => ShellOrphans.record(id, pid, { pid: process.pid }))
      expect(await ShellOrphans.end(id)).toBe(0)
      expect(await withoutPs(() => ShellOrphans.end(id))).toBe(0)
      expect(alive(pid)).toBe(true)
    })

    test("with the server gone, a leader it cannot identify is left alone", async () => {
      const id = session()
      const pid = command("sleep 30")
      await waitFor(() => started(pid) !== "")
      ShellOrphans.record(id, pid, await deadServer())
      expect(await withoutPs(() => ShellOrphans.end(id))).toBe(0)
      expect(alive(pid)).toBe(true)
      // Once it can tell again, the same record still ends it.
      expect(await ShellOrphans.end(id)).toBe(1)
    })

    test("a server that is really gone is known without asking ps", async () => {
      const id = session()
      const pid = command("sleep 30")
      await waitFor(() => started(pid) !== "")
      const server = await deadServer()
      ShellOrphans.record(id, pid, { pid: server.pid })
      expect(await ShellOrphans.end(id)).toBe(1)
    })
  })
})
