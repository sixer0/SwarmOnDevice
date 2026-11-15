import { expect, test } from "bun:test"

// Separate process: the render replaces app contexts with `mock.module`, which would otherwise reach every other file.
// 1.3.0 row 46 (AC-P1d-app, N10-164): one toast per Obsidian open outcome, en and id, success only on `registered`.
test("open graph in Obsidian shows the right toast for each desktop outcome", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel1210-p1d-memory-outcomes.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
