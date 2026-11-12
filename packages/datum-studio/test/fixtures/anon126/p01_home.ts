// Swarm 1.2.6 row 24, flow F7 (P-01 / U6 / U12), 01g section 5.2: the synthetic HOME and the local npm package
// the deterministic driver uses. Never the user's real files: every value is filler or an obvious dummy, and the
// package installs from `file:` (no network). 01g section 4.6: synthetic. Files are data here (not files on disk)
// so the fixture folder keeps neutral file names (G3); `writeP01Home` lays them out in a temp dir.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Relative path -> content of the synthetic home. */
export const P01_HOME_FILES: Readonly<Record<string, string>> = {
  ".ssh/config": ["Host alfa", "  HostName bravo.invalid", "  User charlie", "  Port 8888", ""].join("\n"),
  ".local/share/opencode/auth.json": JSON.stringify({ alfa: { type: "api", key: "xray-8888-8888-zulu" } }, null, 2) + "\n",
}

/** Relative path (inside the package dir) -> content of the local package installed with `file:`. */
export const P01_PACKAGE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "alfa-bravo", version: "8.8.8", private: true, main: "index.js" }, null, 2) + "\n",
  "index.js": "module.exports = 8\n",
}

/** Relative path (inside the scratch project) -> content; the dependency points at the local package. */
export const P01_PROJECT_FILES: Readonly<Record<string, string>> = {
  "package.json":
    JSON.stringify({ name: "charlie-delta", version: "8.8.8", private: true, dependencies: { "alfa-bravo": "file:../alfa_bravo" } }, null, 2) + "\n",
  "notes.md": "Echo foxtrot golf hotel.\n",
}

/** Lays out home, package (`<root>/alfa_bravo`) and project (`<root>/charlie_delta`) under `root`. */
export function writeP01Home(root: string): { home: string; pkg: string; project: string } {
  const home = path.join(root, "home")
  const pkg = path.join(root, "alfa_bravo")
  const project = path.join(root, "charlie_delta")
  const put = (base: string, files: Readonly<Record<string, string>>) => {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(base, rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, body)
    }
  }
  put(home, P01_HOME_FILES)
  put(pkg, P01_PACKAGE_FILES)
  put(project, P01_PROJECT_FILES)
  return { home, pkg, project }
}
