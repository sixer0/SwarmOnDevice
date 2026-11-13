import { expect, test } from "bun:test"

// 1.2.7 U-8 (AC-U8, N7-096). Separate process: the render replaces app contexts with `mock.module`, which would otherwise
// reach every other file.
test("a missing project folder is not entered; one persistent toast offers Restore, Recreate and Choose", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-u8-folder-missing-toast.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
