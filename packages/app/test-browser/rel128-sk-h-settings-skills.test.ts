import { expect, test } from "bun:test"

// 1.2.8 row 42 (AC-SKh, N8-355). Separate process: the render file replaces app contexts with `mock.module`, which
// would otherwise reach every other file.
test("Settings > Skills in v1 and v2: list, off/on, view, edit, new, delete, drafts and the SR8-08 confirm", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel128-sk-h-settings-skills.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 120_000)
