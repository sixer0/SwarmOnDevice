import { rmSync } from "node:fs"
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// `<stateHome>/swarm/datum-studio.env` (Studio spec §9.1): URL, TOKEN, PID; 0600, temp-then-rename, removed on quit.
// Same pattern as app-server.env (app-server-file.ts). PID is the Swarm main process: the launcher accepts the file only
// while that PID is a running `*/Contents/MacOS/Swarm` (spec §9.3 step 3).
export const STUDIO_DESCRIPTOR_FILE = "datum-studio.env"

export function studioDescriptorPath(stateHome: string) {
  return join(stateHome, "swarm", STUDIO_DESCRIPTOR_FILE)
}

export async function writeStudioDescriptor(path: string, endpoint: { url: string; token: string; pid: number }) {
  const fields = { URL: endpoint.url, TOKEN: endpoint.token, PID: String(endpoint.pid) }
  // One KEY=value per line is all the launcher/bridge parse; a line break or `=` in a value would corrupt it.
  if (Object.values(fields).some((value) => value === "" || /[\r\n=]/.test(value)))
    throw new Error("datum-studio descriptor has an empty or unparseable value")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
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

/** Synchronous so it completes inside `will-quit` / `before-quit` even when the process exits right after. */
export function removeStudioDescriptor(path: string) {
  rmSync(path, { force: true })
  rmSync(`${path}.${process.pid}.tmp`, { force: true })
}
