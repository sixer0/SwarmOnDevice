// Swarm 1.3.2 row 17 (S1): capture what the production appender actually renders.
//
// A test that wants to assert a log field cannot use the `Logger.Options` route: `Options` carries `message`, `logLevel`,
// `cause`, `fiber` and `date` only (`effect@4.0.0-beta.83` `dist/Logger.d.ts:79-85`), so the precedent at
// `test/skill/rel127-u11b-warning-once.test.ts:33-42` can count messages but never see a field value. Pointing
// `fileLogger(file, id)` at a temp file instead (`packages/core/src/observability/logging.ts:49`) keeps the transport
// under test — nothing mocks it — and proves the dotted-field rendering end to end, the same way
// `packages/core/test/effect/observability.test.ts:83-109` does for the appender itself.
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "@opencode-ai/core/observability/logging"
import { pollWithTimeout } from "./effect"

/** Written through the same appender as the lines under test, so once it is on disk everything logged before it is too. */
const FLUSH_MARKER = "log capture flush marker"

export type CapturedLog = {
  readonly file: string
  /** Every line the appender has written so far, in write order. Reads whatever is already flushed, so prefer `matching`. */
  readonly lines: () => Effect.Effect<string[]>
  /**
   * Lines holding every needle. Flushes first: it logs a unique marker through the appender under test and waits for
   * that marker to appear, which makes the lines logged before the call complete without depending on the batch window.
   */
  readonly matching: (...needles: string[]) => Effect.Effect<string[]>
}

/** Wraps `self` so its log lines land in a temp file through the production appender, and cleans the file up after it. */
export function withCapturedLog<A, E, R>(self: (log: CapturedLog) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.map(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-capture-"))),
      (directory) => path.join(directory, "opencode.log"),
    ),
    (file) =>
      self({
        file,
        lines: () => readLines(file),
        matching: (...needles) =>
          Effect.gen(function* () {
            const marker = `${FLUSH_MARKER} ${Math.random().toString(36).slice(2)}`
            yield* Effect.logInfo(marker)
            const flushed = yield* pollWithTimeout(
              Effect.gen(function* () {
                const all = yield* readLines(file)
                return all.some((line) => line.includes(marker)) ? all : undefined
              }),
              "production appender never flushed the capture marker",
              "10 seconds",
            )
            return flushed.filter((line) => !line.includes(FLUSH_MARKER) && needles.every((n) => line.includes(n)))
          }).pipe(Effect.orDie),
      }).pipe(
        Effect.provide(
          Logger.layer([fileLogger(file, "log-capture")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie),
        ),
      ),
    (file) => Effect.promise(() => fs.rm(path.dirname(file), { recursive: true, force: true })),
  )
}

/** Lines on disk so far; a capture file that has not been written to yet is simply empty. */
function readLines(file: string) {
  return Effect.promise(async () => {
    const handle = Bun.file(file)
    if (!(await handle.exists())) return []
    return (await handle.text()).split("\n").filter((line) => line.length > 0)
  }).pipe(Effect.orDie)
}
