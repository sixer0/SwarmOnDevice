import { rmSync } from "node:fs"
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

// While the app runs, `swarm run` reaches this app's own server through this file (C120), so a run started in a terminal
// uses the same engine, autonomy rules and approvals as the app and shows up in its Activity. It lives in the app's state
// directory with mode 0600 and is removed on quit; the launcher ignores it unless its PID is a running Swarm.
export function appServerFilePath(stateHome: string) {
  return join(stateHome, "swarm", "app-server.env")
}

// The sidecar's state root (sidecar.ts prepareSidecarEnv): the inherited XDG_STATE_HOME, else the app's userData.
export function appStateHome(env: NodeJS.ProcessEnv, userDataPath: string) {
  return env.XDG_STATE_HOME ?? userDataPath
}

export async function writeAppServerFile(
  path: string,
  server: { url: string; username: string; password: string; pid: number },
) {
  const fields = { URL: server.url, USERNAME: server.username, PASSWORD: server.password, PID: String(server.pid) }
  // One KEY=value per line is all the launcher's `read` loop parses; a line break or `=` in a value would corrupt it.
  if (Object.values(fields).some((value) => value === "" || /[\r\n=]/.test(value)))
    throw new Error("app server descriptor has an empty or unparseable value")
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(
    temp,
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  )
  await chmod(temp, 0o600)
  await rename(temp, path)
}

export function removeAppServerFile(path: string) {
  rmSync(path, { force: true })
}
