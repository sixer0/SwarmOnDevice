// 1.2.9 row 55 (AC-C07a, N9-134): a location that exists but is not a folder is refused at instance boot.
//
// rc4 (68u, C187): with a regular file where the Default Project folder belongs, the app's launch-time config read
// (`x-opencode-directory` = that file) died in config discovery (`FileSystem.access ... ENOTDIR`, an orDie in
// core/src/config.ts) and answered 500 with one ERROR log line. Now the instance boot refuses the location first:
// 400 `LOCATION_NOT_FOLDER` (N9-012) with the fixed, path-free detail "location is not a folder", no ERROR line, and
// no instance left cached for that path, so once the folder is back the next request boots fresh with its config.
// A missing folder (ENOENT) keeps its 1.2.8 behaviour (CHAR case, green at BASE and HEAD).
//
// Run targeted: cd packages/opencode && bun test test/server/rel129-c07a-not-folder-location.test.ts

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { notFolderLocationLayout } from "../fixture/syn129-layouts"

const app = () => Server.Default().app
const LOG = () => path.join(Global.Path.log, "opencode.log")

async function readConfig(directory: string) {
  const response = await app().request("/config", { headers: { "x-opencode-directory": directory } })
  return { status: response.status, text: await response.text() }
}

/** ERROR lines of the server log written after `offset` that name `needle` (the file logger batches, so poll). */
async function errorLinesAfter(offset: number, needle: string, waitMs: number) {
  const until = Date.now() + waitMs
  for (;;) {
    const text = await fs.readFile(LOG(), "utf8").catch(() => "")
    const lines = text
      .slice(offset)
      .split("\n")
      .filter((line) => line.includes("level=ERROR") && line.includes(needle))
    if (lines.length > 0 || Date.now() >= until) return lines
    await Bun.sleep(100)
  }
}

const logSize = () =>
  fs
    .stat(LOG())
    .then((s) => s.size)
    .catch(() => 0)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-C07a a location that is not a folder", () => {
  test(
    "a regular file as x-opencode-directory answers 400 LOCATION_NOT_FOLDER, path-free, with no ERROR line, and is not cached",
    async () => {
      await using layout = await notFolderLocationLayout()
      const offset = await logSize()

      const refused = await readConfig(layout.location)
      // A 500 here is the BASE defect; give its ERROR line time to reach the file so the red log shows both.
      const errors = await errorLinesAfter(offset, layout.root, refused.status >= 500 ? 5000 : 1500)
      expect({ status: refused.status, errorLines: errors.length }).toEqual({ status: 400, errorLines: 0 })
      expect(refused.text).toContain("LOCATION_NOT_FOLDER")
      expect(refused.text).toContain("location is not a folder")
      expect(refused.text).not.toContain(layout.root)
      expect(refused.text).not.toContain("Default Project")

      // No instance cached for the path: once the folder is back, the same request boots fresh and reads its config.
      await layout.restoreAsFolder()
      const restored = await readConfig(layout.location)
      expect(restored.status).toBe(200)
      expect((JSON.parse(restored.text) as { username?: string }).username).toBe(layout.marker.username)
    },
    30_000,
  )

  test(
    "a location under a regular file (ENOTDIR) is refused the same way",
    async () => {
      await using layout = await notFolderLocationLayout()
      const offset = await logSize()
      const refused = await readConfig(layout.childOfFile)
      const errors = await errorLinesAfter(offset, layout.root, refused.status >= 500 ? 5000 : 1500)
      expect({ status: refused.status, errorLines: errors.length }).toEqual({ status: 400, errorLines: 0 })
      expect(refused.text).toContain("LOCATION_NOT_FOLDER")
      expect(refused.text).toContain("location is not a folder")
      expect(refused.text).not.toContain(layout.root)
    },
    30_000,
  )

  test(
    "CHAR: a missing folder (ENOENT) keeps its 1.2.8 behaviour",
    async () => {
      await using layout = await notFolderLocationLayout()
      const missing = path.join(layout.documents, "Absent Folder")
      const answer = await readConfig(missing)
      expect(answer.status).toBe(200)
      expect(answer.text).not.toContain("LOCATION_NOT_FOLDER")
    },
    30_000,
  )
})
