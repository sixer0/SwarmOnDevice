import { expect, test } from "bun:test"

// 1.3.0 row 82 (AC-B1015, N10-205 part 1). Separate process: the render replaces the toast module with `mock.module`,
// which would otherwise reach every other file, and it drives Bun's fake clock.
test("a Restore or Recreate reload that never settles is cut off after 10,000 ms; settled reloads as before", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel1210-b1015-reload-timeout.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
