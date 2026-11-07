import { expect, test } from "bun:test"

// Row 112 (studio spec §8.2): separate process, because the render replaces app contexts with `mock.module`, which
// would otherwise reach every other file.
test("Studio PDF and HTML outputs preview inside the existing file tab; other files and outside paths do not", async () => {
  const run = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./test-browser/file-preview.render.ts"],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
