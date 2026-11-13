import { expect, test } from "bun:test"

// Separate process: the render replaces app contexts with `mock.module`, which would otherwise reach every other file.
// 1.2.8 row 42c (AC-OBSf, OBS-f-2, N8-362): the one "Open graph in Obsidian" action in the existing memory view.
test("memory view has one Obsidian action that says when there is no hub yet", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel128-obs-f-memory-button.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
