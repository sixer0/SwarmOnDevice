import { expect, test } from "bun:test"

// Swarm 1.2.7 row 58g (C101), AC-U5 live findings: F-11 (an expanded Decisions entry clipped at 1024x640) and the
// answered decision card that stayed in the Mission Control side panel. Separate process: the render replaces app
// contexts with `mock.module`.
test("1.2.7 row 58g: Decisions list scrolls to every action of an expanded entry; an answered decision leaves no card", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-58g-decisions-answered.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)
