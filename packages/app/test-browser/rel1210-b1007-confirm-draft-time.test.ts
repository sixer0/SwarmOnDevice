import { expect, test } from "bun:test"

// 1.2.10 row 70 (AC-B1007a, N10-197). Separate process: the render file replaces app contexts with `mock.module`,
// which would otherwise reach every other file.
test("Settings > Skills in v1 and v2: every draft approve sends the listed draftTime and reloads on SKILL_CHANGED", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel1210-b1007-confirm-draft-time.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 120_000)
