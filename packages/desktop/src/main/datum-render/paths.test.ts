import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BridgeError } from "./protocol"
import { checkInputPath, checkOutputPath, defaultPolicy, isAllowedRendererUrl, studioStoreGrants, type PathPolicy } from "./paths"
import { studioStoreRoot } from "../datum-studio-host/layout"

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

// Row 151c (C161 I1): the installed layout. HOME_DENY protects ~/.local/share/swarm, where the Studio store lives
// (layout.ts studioStoreRoot). The host's grants open exactly the stored HTML renders (read) and the page-image
// folders (write); every other store file and the rest of the protected folder stay refused.
describe("row 151c: Studio store grants under the protected ~/.local/share/swarm", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "row151c-home-")))
  const store = studioStoreRoot({}, home)
  for (const d of ["docs/doc1/r1", "verify/out1", "assets", "tmp/preview/x", "logs"]) mkdirSync(join(store, d), { recursive: true })
  writeFileSync(join(store, "docs/doc1/r1/nota.html"), "<p>x</p>")
  writeFileSync(join(store, "docs/doc1/r1/nota.pdf"), "%PDF")
  writeFileSync(join(store, "datum-studio.sqlite"), "db")
  writeFileSync(join(store, "assets/a.html"), "<p>a</p>")
  writeFileSync(join(store, "tmp/preview/x/p.html"), "<p>p</p>")
  mkdirSync(join(home, ".local/share/swarm/other"), { recursive: true })
  writeFileSync(join(home, ".local/share/swarm/other/auth.html"), "secret")
  mkdirSync(join(home, ".ssh"))
  writeFileSync(join(home, ".ssh/id.html"), "k")
  symlinkSync(join(store, "datum-studio.sqlite"), join(store, "docs/doc1/r1/db.html"))
  symlinkSync(join(home, ".ssh"), join(store, "verify/sshlink"))
  const before = defaultPolicy(home)
  const after = defaultPolicy(home, [], studioStoreGrants(store))

  test("the store root is the real installed one (~/.local/share/swarm/datum-studio)", () => {
    expect(store).toBe(join(home, ".local", "share", "swarm", "datum-studio"))
  })

  test("before (no grants): the stored HTML and the page-image folder are refused (row 135b I1)", () => {
    expect(code(() => checkInputPath(join(store, "docs/doc1/r1/nota.html"), before))).toBe("PATH_REFUSED")
    expect(code(() => checkOutputPath(join(store, "verify/out1/p001.png"), before))).toBe("PATH_REFUSED")
  })

  test("after: read <store>/docs/**.html and write <store>/verify/<id>/*.png", () => {
    expect(checkInputPath(join(store, "docs/doc1/r1/nota.html"), after)).toBe(join(store, "docs/doc1/r1/nota.html"))
    expect(checkOutputPath(join(store, "verify/out1/p001.png"), after)).toBe(join(store, "verify/out1/p001.png"))
  })

  test("everything else in the store and the protected folder stays refused", () => {
    const refusedIn = [
      join(store, "datum-studio.sqlite"),
      join(store, "docs/doc1/r1/nota.pdf"), // not HTML
      join(store, "docs/doc1/r1/db.html"), // a link to the sqlite file: its real path is outside docs/
      join(store, "assets/a.html"),
      join(store, "tmp/preview/x/p.html"),
      join(home, ".local/share/swarm/other/auth.html"),
      join(home, ".ssh/id.html"),
    ]
    for (const p of refusedIn) expect([p, code(() => checkInputPath(p, after))]).toEqual([p, "PATH_REFUSED"])
    const refusedOut = [
      join(store, "datum-studio.sqlite"),
      join(store, "verify/p001.png"), // depth 1
      join(store, "verify/out1/p001.html"), // not PNG
      join(store, "docs/doc1/r1/p001.png"), // docs is read-only
      join(store, "verify/sshlink/p001.png"), // real parent is ~/.ssh
      join(store, "logs/p001.png"),
      join(home, ".local/share/swarm/other/p001.png"),
    ]
    for (const p of refusedOut) expect([p, code(() => checkOutputPath(p, after))]).toEqual([p, "PATH_REFUSED"])
    // A write grant never reads, a read grant never writes.
    expect(code(() => checkOutputPath(join(store, "docs/doc1/r1/nota.html"), after))).toBe("PATH_REFUSED")
  })

  test("a store root outside the protected folder (XDG_DATA_HOME elsewhere) needs no grant and keeps working", () => {
    const xdg = realpathSync(mkdtempSync(join(tmpdir(), "row151c-xdg-")))
    const s2 = studioStoreRoot({ XDG_DATA_HOME: xdg }, home)
    mkdirSync(join(s2, "verify/o"), { recursive: true })
    expect(checkOutputPath(join(s2, "verify/o/p001.png"), defaultPolicy(home, [], studioStoreGrants(s2)))).toBe(join(s2, "verify/o/p001.png"))
  })
})
