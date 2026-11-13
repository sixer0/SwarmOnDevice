import { expect, test } from "bun:test"

// Swarm 1.2.7 row 27, AC-U5 (N7-088; C6, D-11, SR7-14). One scroll rule for three surfaces: the mission decision card,
// the permission prompt and the Decisions list. Separate process: the render replaces app contexts with `mock.module`.
test("1.2.7 U-5: bounded scrolling body, actions outside it, scrollbar not hidden, on all three surfaces", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-u5-scroll-contract.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)
