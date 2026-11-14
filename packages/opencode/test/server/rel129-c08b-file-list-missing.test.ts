// 1.2.9 row 56a (AC-C08b, N9-137; S9-16): `file.list` on a folder that does not exist inside the location.
//
// 1.2.8: Mission Control polls `GET /file?path=docs/<mission>` for a mission whose folder is not there yet. Core's
// `FileSystem.list` resolves the target with `realPath(...).pipe(Effect.orDie)`, so every poll answered 500 and wrote
// one ERROR line (`NotFound: FileSystem.realPath`). Now the handler checks, after the lexical containment check and
// before `fs.list`, whether the target exists inside the location: if not, it answers 200 `[]` and logs
// `file.list: path not found` (N9-014) at WARN once per folder per process, with the relative path as a structured
// field only, for at most `FILE_LIST_MISSING_LOG_MAX` (N9-057, 256) folders.
//
// S9-16: the existence check is an `lstat` walk below the location that never follows a link. A link (to anywhere)
// keeps today's realPath containment, so the answer for a link to an outside folder is the same whether that
// folder exists or not. A path that escapes the location keeps today's refusal.
//
// Run targeted: cd packages/opencode && bun test test/server/rel129-c08b-file-list-missing.test.ts

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const WARN_TEXT = "file.list: path not found"
const CAP = 256
const app = () => Server.Default().app
const LOG = () => path.join(Global.Path.log, "opencode.log")

const logSize = () =>
  fs
    .stat(LOG())
    .then((s) => s.size)
    .catch(() => 0)
const logLinesAfter = async (offset: number) =>
  (await fs.readFile(LOG(), "utf8").catch(() => "")).slice(offset).split("\n").filter(Boolean)

/** Poll the batched file logger until `count(lines) >= want` or the wait ends; then let one more batch land. */
async function settle(offset: number, count: (lines: string[]) => number, want: number, waitMs = 5000) {
  const until = Date.now() + waitMs
  while (count(await logLinesAfter(offset)) < want && Date.now() < until) await Bun.sleep(100)
  await Bun.sleep(1500)
  return logLinesAfter(offset)
}

const warnLines = (lines: string[]) => lines.filter((l) => l.includes("level=WARN") && l.includes(WARN_TEXT))
const errorLines = (lines: string[], needle: string) =>
  lines.filter((l) => l.includes("level=ERROR") && l.includes(needle))

async function list(location: string, rel: string) {
  const response = await app().request(`/file?path=${encodeURIComponent(rel)}`, {
    headers: { "x-opencode-directory": location },
  })
  return { status: response.status, text: await response.text() }
}

const normalizeRef = (answer: { status: number; text: string }) => ({
  ...answer,
  text: answer.text.replace(/"ref":"err_[0-9a-f]+"/g, '"ref":"err_*"'),
})

/** A syn129 root: `<root>/project` is the location (with `docs/`), `<root>/outside` sits next to it. */
async function layout() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syn129-c08b-")))
  const location = path.join(root, "project")
  const outside = path.join(root, "outside")
  await fs.mkdir(path.join(location, "docs", "present"), { recursive: true })
  await fs.writeFile(path.join(location, "docs", "present", "x.md"), "syn129 deliverable\n")
  await fs.mkdir(path.join(outside, "sub"), { recursive: true })
  const token = path.basename(root).slice("syn129-c08b-".length)
  return {
    root,
    location,
    outside,
    token,
    [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

let fileStart = 0
beforeAll(async () => {
  fileStart = await logSize()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-C08b file.list on a missing folder", () => {
  test("5 polls of an absent folder answer 200 [] with one WARN line (relative path field only) and no ERROR", async () => {
    await using fx = await layout()
    const absent = `docs/syn129-absent-${fx.token}`
    const offset = await logSize()

    const answers = []
    for (let i = 0; i < 5; i++) answers.push(await list(fx.location, absent))
    const lines = await settle(offset, (l) => warnLines(l).length + errorLines(l, fx.root).length, 1)

    expect({
      statuses: answers.map((a) => a.status),
      bodies: answers.map((a) => a.text),
      errorLines: errorLines(lines, fx.root).length,
    }).toEqual({ statuses: [200, 200, 200, 200, 200], bodies: ["[]", "[]", "[]", "[]", "[]"], errorLines: 0 })

    const warns = warnLines(lines)
    expect(warns.length).toBe(1)
    // The message is the fixed text; the path is only a structured field, relative, never the absolute folder.
    expect(warns[0]).toContain(`message="${WARN_TEXT}"`)
    expect(warns[0]).toContain(`path=${absent}`)
    expect(warns[0]).not.toContain(fx.root)

    // A second absent folder (also one level deeper) gets its own single line.
    const second = `docs/syn129-other-${fx.token}/deeper`
    const offset2 = await logSize()
    const again = [await list(fx.location, second), await list(fx.location, second), await list(fx.location, absent)]
    const lines2 = await settle(offset2, (l) => warnLines(l).length, 1)
    expect(again.map((a) => [a.status, a.text])).toEqual([
      [200, "[]"],
      [200, "[]"],
      [200, "[]"],
    ])
    expect(warnLines(lines2).length).toBe(1)
    expect(warnLines(lines2)[0]).toContain(`path=${second}`)
    expect(errorLines(lines2, fx.root).length).toBe(0)
  }, 30_000)

  test("an existing folder still lists, and an escaping path keeps its refusal (no WARN, no [])", async () => {
    await using fx = await layout()
    const offset = await logSize()

    const present = await list(fx.location, "docs/present")
    expect(present.status).toBe(200)
    expect(JSON.parse(present.text)).toContainEqual(expect.objectContaining({ name: "x.md", type: "file" }))

    for (const escape of ["../outside", "../outside/absent", "../syn129-nowhere", fx.outside]) {
      const answer = await list(fx.location, escape)
      expect({ escape, status: answer.status, empty: answer.text === "[]" }).toEqual({
        escape,
        status: 500,
        empty: false,
      })
    }
    const lines = await settle(offset, () => 0, 0, 0)
    expect(warnLines(lines).filter((l) => l.includes(fx.token)).length).toBe(0)
    expect(warnLines(lines).filter((l) => l.includes("outside") || l.includes("nowhere")).length).toBe(0)
  }, 30_000)

  test("S9-16: a link to an outside folder answers the same whether the outside folder exists or not", async () => {
    await using fx = await layout()
    // docs/out -> <root>/outside (exists, with sub/); docs/gone -> <root>/vanished (does not exist).
    await fs.symlink(fx.outside, path.join(fx.location, "docs", "out"))
    await fs.symlink(path.join(fx.root, "vanished"), path.join(fx.location, "docs", "gone"))
    const offset = await logSize()

    const pairs = [
      ["docs/out", "docs/gone"],
      ["docs/out/sub", "docs/gone/sub"],
      ["docs/out/absent", "docs/gone/absent"],
    ] as const
    for (const [existing, missing] of pairs) {
      // A 500 body carries a per-error `ref`; everything else must be identical.
      const a = normalizeRef(await list(fx.location, existing))
      const b = normalizeRef(await list(fx.location, missing))
      expect({ existing, status: a.status, text: a.text }).toEqual({ existing, status: b.status, text: b.text })
      expect({ existing, status: a.status, empty: a.text === "[]" }).toEqual({ existing, status: 500, empty: false })
    }
    const lines = await settle(offset, () => 0, 0, 0)
    expect(warnLines(lines).filter((l) => l.includes("docs/out") || l.includes("docs/gone")).length).toBe(0)
  }, 30_000)

  test(`after ${CAP} distinct missing folders no further WARN line is written (FILE_LIST_MISSING_LOG_MAX)`, async () => {
    await using fx = await layout()
    // CAP folders in parallel batches fill the set (with the earlier tests' folders it is full); the last 4 go
    // one by one afterwards, so none of them may be logged.
    const tail = 4
    const count = CAP + tail
    const status = (rel: string) => list(fx.location, rel).then((a) => (a.text === "[]" ? a.status : -a.status))
    const answers: number[] = []
    for (let i = 0; i < CAP; i += 32) {
      const size = Math.min(32, CAP - i)
      answers.push(
        ...(await Promise.all(Array.from({ length: size }, (_, k) => status(`docs/syn129-cap-${fx.token}-${i + k}`)))),
      )
    }
    for (let i = CAP; i < count; i++) answers.push(await status(`docs/syn129-cap-${fx.token}-${i}`))
    expect(answers.filter((s) => s !== 200).length).toBe(0)

    // Every WARN line of this file's run counts against the one per-process set.
    const lines = await settle(fileStart, (l) => warnLines(l).length, CAP)
    const all = warnLines(lines)
    expect(all.length).toBe(CAP)
    for (let i = CAP; i < count; i++) {
      const late = new RegExp(`path=docs/syn129-cap-${fx.token}-${i}(\\s|$)`)
      expect({ i, lines: all.filter((l) => late.test(l)).length }).toEqual({ i, lines: 0 })
    }
  }, 60_000)
})
