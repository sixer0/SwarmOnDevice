import fs from "node:fs"
import path from "node:path"

function runnable(file: string) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The file `searchPath` names for a program, as `Bun.which` answers it. The packaged app's server runs on Node, where the
 * `Bun` global does not exist, and a choice that depends on the answer has to come out the same on both.
 */
export function findProgram(name: string, searchPath: string) {
  // Not tried on Windows, where this looks through PATHEXT rather than at the mode.
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((extension) => name + extension)
      : [name]
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue
    for (const candidate of names) {
      const file = path.join(entry, candidate)
      if (runnable(file)) return file
    }
  }
  return undefined
}
