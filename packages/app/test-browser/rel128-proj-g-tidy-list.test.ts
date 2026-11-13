import { expect, test } from "bun:test"

// Swarm 1.2.8 row 46b (N8-368; AC-PROJg render half, C98 retry card). Separate process: the render replaces
// app contexts with `mock.module`.
test("1.2.8 row 46b: tidy list and placement retry in the decision card", async () => {
  const run = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./test-browser/rel128-proj-g-tidy-list.render.ts"],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)
