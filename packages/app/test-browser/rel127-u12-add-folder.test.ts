import { expect, test } from "bun:test"

// U-12 (1.2.7 row U12). Separate process: the render registers a Bun plugin that compiles session-ui's JSX for Solid.
test("U-12: the composer's add menu has Add folder; it adds the picked folder as an x-directory reference", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel127-u12-add-folder.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 4 pass")
  expect(output).toContain(" 0 fail")
}, 60_000)
