import { expect, test } from "bun:test"

// Separate process: the render replaces app contexts with `mock.module`, which would otherwise reach every other file.
// 1.2.10 row 59 (AC-P4-view, N10-180): the person-only "Copy to vault" / "In vault: remove" actions in the memory view.
test("project memory offers copy and remove to the person only, with the in-row confirmation and the nonce", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel1210-p4-view-actions.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
