import { expect, test } from "bun:test"

// 1.2.9 row 79a (LIVE-C07, C112). Separate process: the render replaces the toast module with `mock.module`, which would
// otherwise reach every other file.
test("a 400 LOCATION_NOT_FOLDER shows the folder notice, not the error page; Restore renders the project again", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel129-79a-not-folder-app.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
