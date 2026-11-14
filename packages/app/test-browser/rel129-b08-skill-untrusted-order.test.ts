import { expect, test } from "bun:test"

// 1.2.9 row 48b (AC-B08, N9-125). Separate process: the render file replaces app contexts with `mock.module`, which
// would otherwise reach every other file.
test("Settings > Skills in v1 and v2: an untrusted command-running draft is refused before the second confirm", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel129-b08-skill-untrusted-order.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 120_000)
