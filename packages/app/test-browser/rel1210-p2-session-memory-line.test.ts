import { expect, test } from "bun:test"

// Separate process: the render replaces app contexts with `mock.module`, which would otherwise reach every other file.
// 1.2.10 row 47 (AC-P2a, AC-P2b, AC-P2c, T7 of AC-P2d): the project memory line stays on the session page.
test("the project memory line shows under the session composer for the whole session", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel1210-p2-session-memory-line.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
