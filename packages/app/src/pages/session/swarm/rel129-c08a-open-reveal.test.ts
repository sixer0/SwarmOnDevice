// Swarm 1.2.9 row 56b (AC-C08a residual, decision C53). Row 56 lists a deliverable found in the mission's folder (the
// Default Project root) while the session sits in a group; Open and Reveal of that line must act on the file in the
// mission's folder, not on the group's path. The mount is rendered in its own process (Solid JSX transform and module
// mocks), as mission-control.test.ts does: rel129-c08a-open-reveal.render.ts.
import { expect, test } from "bun:test"

test("row 56b: Open and Reveal of a deliverable use the folder it was found in (render half)", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./src/pages/session/swarm/rel129-c08a-open-reveal.render.ts",
    ],
    { cwd: new URL("../../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toContain(" 3 pass")
}, 60_000)
