// Row 134: mission control end to end (real Studio host -> real desktop mission bridge -> app components). The DOM
// harness mission-control-e2e.render.ts runs in its own process (browser conditions, Solid JSX, mocked language
// context), the row 130/132/133 pattern. It starts a datum-studio host on an ephemeral 127.0.0.1 port, so this file
// needs local port binding (command sandbox off).
//
// Second test: the mutation of the blueprint ("phase filter removed"). The host fixture applies it in memory
// (R134_MUTATION=phase-filter: derived phases = every builtin phase instead of the mission type's); the four
// "shows only its phases" tests must fail. No file on disk is changed.
import { expect, test } from "bun:test"

const APP = new URL("../../../..", import.meta.url).pathname
const HARNESS = "./src/pages/session/swarm/mission-control-e2e.render.ts"

async function harness(extraEnv: Record<string, string>, args: string[] = []) {
  const run = Bun.spawn([process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", HARNESS, ...args], {
    cwd: APP,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  // keep the quoted evidence lines of the harness in this run's output
  for (const line of out.split("\n")) if (line.startsWith("[row134]")) console.log(line)
  return { code, output: err }
}

test("mission control e2e: 4 fixture missions from the real host, through the desktop bridge, rendered by the app", async () => {
  const { code, output } = await harness({})
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 13 pass")
  expect(output).toContain(" 0 fail")
}, 180_000)

test("mutation: with the type phase filter removed in the host, every 'shows only its phases' test fails", async () => {
  const { code, output } = await harness({ R134_MUTATION: "phase-filter" }, ["-t", "shows only its phases"])
  expect(code).not.toBe(0)
  expect(output).toContain(" 0 pass")
  expect(output).toContain(" 4 fail")
}, 120_000)
