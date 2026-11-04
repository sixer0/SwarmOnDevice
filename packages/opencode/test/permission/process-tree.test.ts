// 1.1.1 R3b (S1.28): which processes are Swarm's, read from `ps`. Whatever goes wrong is an empty set, so a kill waits.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ProcessTree } from "../../src/permission/process-tree"

const PS = `    1     0
  100     1
  200   100
  201   100
  300   200
  400     1
  garbage line
  500   abc
  600   600
`

describe("ProcessTree", () => {
  test("parse reads pid and ppid per line and leaves out what is not two whole numbers", () => {
    const parents = ProcessTree.parse(PS)
    expect([...parents]).toEqual([
      [1, 0],
      [100, 1],
      [200, 100],
      [201, 100],
      [300, 200],
      [400, 1],
      [600, 600],
    ])
  })

  test("below returns every descendant, the root itself left out, and a self-parented line loops nowhere", () => {
    const parents = ProcessTree.parse(PS)
    expect([...ProcessTree.below(parents, 100)].sort((a, b) => a - b)).toEqual([200, 201, 300])
    expect([...ProcessTree.below(parents, 300)]).toEqual([])
    expect([...ProcessTree.below(parents, 600)]).toEqual([])
    expect(ProcessTree.below(parents, 999).size).toBe(0)
  })

  test("a cycle in the table ends", () => {
    const parents = new Map([
      [10, 11],
      [11, 10],
    ])
    expect([...ProcessTree.below(parents, 10)]).toEqual([11])
  })

  test("descendants uses the output it is handed", async () => {
    expect([...(await ProcessTree.descendants(100, async () => PS))].sort((a, b) => a - b)).toEqual([200, 201, 300])
  })

  test("a failing or throwing ps is an empty set", async () => {
    expect((await ProcessTree.descendants(100, () => Promise.reject(new Error("no ps")))).size).toBe(0)
    expect(
      (
        await ProcessTree.descendants(100, () => {
          throw new Error("spawn failed")
        })
      ).size,
    ).toBe(0)
    expect((await ProcessTree.descendants(100, async () => "")).size).toBe(0)
  })

  test("the real ps finds a child this test starts, and never the server pid itself", async () => {
    const child = Bun.spawn(["sleep", "5"])
    try {
      const found = await ProcessTree.descendants()
      expect(found.has(process.pid)).toBe(false)
      // `ps` may be unavailable in a sandbox: then the set is empty, which is the safe answer.
      if (found.size > 0) expect(found.has(child.pid)).toBe(true)
    } finally {
      child.kill()
    }
  })

  // 1.1.1 F1a (D-F1-4): the seam takes a session and names only what that session's shell tool started.
  test("ofSession: the recorded commands still running and everything below them, nothing else", async () => {
    let ran = 0
    const run = async () => {
      ran++
      return PS
    }
    // 100 runs with 200, 201 and 300 below it; 999 is no longer running and names nothing.
    const found = await ProcessTree.ofSession("ses_a", run, () => [100, 999])
    expect([...found].sort((a, b) => a - b)).toEqual([100, 200, 201, 300])
    expect(ran).toBe(1)
    expect((await ProcessTree.ofSession("ses_a", run, () => [400])).has(100)).toBe(false)
  })

  test("ofSession: no record is an empty set, and ps is not even run", async () => {
    let ran = 0
    const found = await ProcessTree.ofSession("ses_a", async () => (ran++, PS), () => [])
    expect(found.size).toBe(0)
    expect(ran).toBe(0)
  })

  test("ofSession: a failing ps or record reader is an empty set, and this server is never in it", async () => {
    expect((await ProcessTree.ofSession("ses_a", () => Promise.reject(new Error("no ps")), () => [100])).size).toBe(0)
    expect(
      (
        await ProcessTree.ofSession(
          "ses_a",
          async () => PS,
          () => {
            throw new Error("unreadable")
          },
        )
      ).size,
    ).toBe(0)
    const self = `${process.pid} 1\n${process.pid + 1000000} ${process.pid}\n`
    expect((await ProcessTree.ofSession("ses_a", async () => self, () => [process.pid])).size).toBe(0)
  })

  describe("roots", () => {
    const session = "ses_f1a_roots"
    const folder = path.join(Global.Path.state, "shell-running", session)
    afterEach(() => fs.rmSync(folder, { recursive: true, force: true }))
    const write = (name: string, body: string) => {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, name), body)
    }

    test("reads only this server's records of that session; a dead server's, a broken one and another session's are left out", () => {
      write("4242.json", JSON.stringify({ pid: 4242, server: { pid: process.pid } }))
      write("4343.json", JSON.stringify({ pid: 4343, server: { pid: process.pid + 1 } }))
      write("4444.json", "{not json")
      write("1.json", JSON.stringify({ pid: 1, server: { pid: process.pid } }))
      write("note.txt", JSON.stringify({ pid: 4545, server: { pid: process.pid } }))
      expect(ProcessTree.roots(session)).toEqual([4242])
      expect(ProcessTree.roots("ses_f1a_other")).toEqual([])
      // A session id is a file name, never a path.
      expect(ProcessTree.roots(`../shell-running/${session}`)).toEqual([4242])
    })
  })
})
