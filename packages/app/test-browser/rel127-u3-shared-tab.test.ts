import { expect, test } from "bun:test"

// 1.2.7 U-3 (AC-U3, N7-086). Separate process: the render replaces app contexts with `mock.module`, which would otherwise
// reach every other file.
test('the multi-writer block leaves the Agents view for a conditional "Shared files" entry of the Activity strip', async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-u3-shared-tab.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
