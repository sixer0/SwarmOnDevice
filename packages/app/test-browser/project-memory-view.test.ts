import { expect, test } from "bun:test"

// Separate process: the render replaces app contexts with `mock.module`, which would otherwise reach every other file.
// 1.2.6 row 41d (P-05/UX-02): a note's body and refs show read-only under it, and refusals name their limit.
test("project memory shows body and refs read-only and names the limit in refusals", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/project-memory-view.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
