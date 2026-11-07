import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BridgeError } from "./protocol"
import { checkInputPath, checkOutputPath, defaultPolicy, isAllowedRendererUrl, type PathPolicy } from "./paths"

const root = realpathSync(mkdtempSync(join(tmpdir(), "row24-paths-")))
const outside = realpathSync(mkdtempSync(join(tmpdir(), "row24-outside-")))
const policy: PathPolicy = { roots: [root], deny: [join(root, ".ssh")], maxInputBytes: 64 }
writeFileSync(join(root, "a.svg"), "<svg/>")
writeFileSync(join(root, "big.svg"), "x".repeat(65))
writeFileSync(join(outside, "o.svg"), "<svg/>")
mkdirSync(join(root, ".ssh"))
mkdirSync(join(root, "dir.png"))
symlinkSync(join(outside, "o.svg"), join(root, "link.svg"))
symlinkSync(join(outside, "o.svg"), join(root, "link.png"))
symlinkSync(outside, join(root, "escape"))

function code(fn: () => unknown) {
  try {
    fn()
  } catch (e) {
    return e instanceof BridgeError ? e.code : "OTHER"
  }
  return "NONE"
}

afterAll(() => {})

describe("render bridge path allow-list", () => {
  test("accepts an absolute input inside a root", () => {
    expect(checkInputPath(join(root, "a.svg"), policy)).toBe(join(root, "a.svg"))
  })

  test("refuses relative, non-normalised and NUL paths", () => {
    expect(code(() => checkInputPath("a.svg", policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath("out/a.png", policy))).toBe("PATH_REFUSED")
    expect(code(() => checkInputPath(`${root}/x/../a.svg`, policy))).toBe("PATH_REFUSED")
    expect(code(() => checkInputPath(`${root}//a.svg`, policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(`${root}/a\0.png`, policy))).toBe("PATH_REFUSED")
  })

  test("refuses inputs outside the roots, also through a symlink", () => {
    expect(code(() => checkInputPath(join(outside, "o.svg"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkInputPath(join(root, "link.svg"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkInputPath(join(root, "missing.svg"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkInputPath(join(root, "big.svg"), policy))).toBe("INPUT_TOO_LARGE")
  })

  test("refuses outputs through symlinks, into folders, into protected folders", () => {
    expect(checkOutputPath(join(root, "new.png"), policy)).toBe(join(root, "new.png"))
    expect(code(() => checkOutputPath(join(root, "link.png"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(root, "escape", "x.png"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(root, "dir.png"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(root, ".ssh", "x.png"), policy))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(root, "nofolder", "x.png"), policy))).toBe("PATH_REFUSED")
  })

  test("default policy denies credential and Swarm folders under home", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "row24-home-")))
    mkdirSync(join(home, ".ssh"))
    mkdirSync(join(home, ".swarm"))
    mkdirSync(join(home, "work"))
    const p = defaultPolicy(home)
    expect(checkOutputPath(join(home, "work", "a.png"), p)).toBe(join(home, "work", "a.png"))
    expect(code(() => checkOutputPath(join(home, ".ssh", "a.png"), p))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(home, ".swarm", "a.png"), p))).toBe("PATH_REFUSED")
  })

  test("renderer URL gate: data and about:blank only, file only when allow-listed, never network", () => {
    const font = join(root, "a.svg")
    const allowed = new Set([font])
    expect(isAllowedRendererUrl("data:font/ttf;base64,AAAA", allowed)).toBe(true)
    expect(isAllowedRendererUrl("about:blank", allowed)).toBe(true)
    expect(isAllowedRendererUrl(pathToFileURL(font).href, allowed)).toBe(true)
    expect(isAllowedRendererUrl(pathToFileURL(join(root, "big.svg")).href, allowed)).toBe(false)
    expect(isAllowedRendererUrl("file:///etc/passwd", allowed)).toBe(false)
    expect(isAllowedRendererUrl("file://host/share/a.svg", allowed)).toBe(false)
    for (const u of ["http://127.0.0.1:9/x", "https://example.com/f.woff2", "ws://localhost/", "ftp://x/", "blob:https://x/1", "chrome://gpu", "devtools://x"]) {
      expect(isAllowedRendererUrl(u, allowed)).toBe(false)
    }
  })
})
