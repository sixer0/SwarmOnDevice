// Swarm 1.2.10 row 50 (N10-170, AC-P3c): runs rel1210-p3c-drift-line.render.ts in its own process (it compiles Solid
// JSX and mocks the language context, like mission-control.test.ts does for mission-control.render.ts).
import { expect, test } from "bun:test"

test("P3-c: the drift line names changed steps, en and id", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./src/pages/session/swarm/rel1210-p3c-drift-line.render.ts",
    ],
    { cwd: new URL("../../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toContain(" 8 pass")
}, 60_000)
