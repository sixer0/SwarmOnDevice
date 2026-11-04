// Swarm 1.1.1 F19 (n41): since P30 an install opens only when no folder above the repository's top holds a `package.json`
// or a pnpm workspace file. A test that expects an install to open depends on the machine's folders above its fixture, so
// it checks them first and says so when they are not bare, instead of failing on a verdict. 1.1.1 F20 (n46): the one
// helper for this precondition; `nodeModules` also asks for no `node_modules` folder (npm's install root marks).
import fs from "node:fs"
import path from "node:path"

/** Throws, naming the file, when `from` or any folder above it holds a manifest or a pnpm workspace file. */
export function expectBareFrom(from: string, options: { nodeModules?: boolean } = {}) {
  const names = ["package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", ...(options.nodeModules ? ["node_modules"] : [])]
  for (let up = from; ; up = path.dirname(up)) {
    const found = names.find((name) => fs.existsSync(path.join(up, name)))
    if (found)
      throw new Error(`test fixture: ${path.join(up, found)} sits at or above ${from}; an install there keeps 1.1.0 (P30), so this test cannot run here`)
    if (path.dirname(up) === up) return
  }
}

/** Throws, naming the file, when `dir`'s parent or any folder above it holds a manifest or a pnpm workspace file. */
export const expectNoManifestAbove = (dir: string) => expectBareFrom(path.dirname(dir))
