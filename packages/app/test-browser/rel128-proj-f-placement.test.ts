import { expect, test } from "bun:test"

// Swarm 1.2.8 row 46 (N8-367; AC-PROJf render half, AC-SEC05 feed label N8-462). Separate process: the render replaces
// app contexts with `mock.module`.
test("1.2.8 row 46: placement card in the decision card; unattested answer label in the feed", async () => {
  const run = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./test-browser/rel128-proj-f-placement.render.ts"],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)
