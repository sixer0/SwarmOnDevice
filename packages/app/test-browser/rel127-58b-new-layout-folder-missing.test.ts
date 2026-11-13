import { expect, test } from "bun:test"

// 1.2.7 row 58b (AC-U8, F-4): U-8 in the new layout. Separate process: the render replaces app contexts with `mock.module`, which would otherwise
// reach every other file.
test("new layout: a missing project folder is not opened or entered; the shared U-8 notice shows", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-58b-new-layout-folder-missing.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
