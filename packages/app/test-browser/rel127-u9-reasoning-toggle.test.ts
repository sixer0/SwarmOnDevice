import { expect, test } from "bun:test"

// N7-128 (AC-U9, row 34). Separate process: the render replaces session-ui's markdown module with `mock.module`, which
// would otherwise reach every other file.
test("U-9: each reasoning block has its own show/hide toggle (click, Enter, Space); the setting sets its default", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-u9-reasoning-toggle.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 5 pass")
  expect(output).toContain(" 0 fail")
}, 60_000)
