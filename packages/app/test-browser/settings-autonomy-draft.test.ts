import { expect, test } from "bun:test"

// Separate process: these tests replace app contexts with `mock.module`, which would otherwise reach every other file.
test("the Settings row and the add menu change one folder level on a draft", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/settings-autonomy-draft.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 60_000)
