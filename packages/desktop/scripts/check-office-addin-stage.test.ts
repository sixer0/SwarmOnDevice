import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Configuration } from "electron-builder"
import { OFFICE_JS_URL, OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"
import {
  CEILING_BYTES,
  checkPaneHtml,
  checkResources,
  checkStage,
  checkVersionPolicy,
  MANIFEST_VERSIONS,
  STAGE_FOLDER,
} from "./check-office-addin-stage"
import { stage } from "./stage-office-addin"

// M9-01: the Office add-in stage gate against fixture trees (U-MAN-03, SD §12.1, C26(b), C52/F-5, F-6, E7, IM-18),
// and the U5 guard U-DT-09 on the builder config. Nothing here runs vite or touches the real stage.

const REAL_MANIFEST = await Bun.file(join(import.meta.dir, "..", "..", "office-addin", "manifest", OFFICE_MANIFEST_FILE)).text()
const HTML = `<!doctype html><html><head><script src="${OFFICE_JS_URL}"></script>
<script type="module" crossorigin src="./assets/index-AbCd12_-.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-Zz99yy00.css"></head><body><div id="root"></div></body></html>`

let root = ""
let desktop = ""
let addin = ""
let dist = ""

function write(file: string, text: string | Buffer) {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}

// A fixture checkout: packages/desktop (release 1.3.1) beside packages/office-addin with a built dist/pane that is
// newer than every source.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-addin-stage-"))
  desktop = join(root, "desktop")
  addin = join(root, "office-addin")
  dist = join(addin, "dist", "pane")
  write(join(desktop, "package.json"), JSON.stringify({ version: MANIFEST_VERSIONS.at(-1)!.release }))
  write(join(addin, "manifest", OFFICE_MANIFEST_FILE), REAL_MANIFEST)
  write(join(addin, "src", "index.tsx"), "export {}\n")
  write(join(addin, "src", "views", "a.test.ts"), "export {}\n")
  write(join(addin, "index.html"), "<html></html>\n")
  write(join(addin, "vite.config.ts"), "export default {}\n")
  write(join(addin, "package.json"), "{}\n")
  write(join(dist, "index.html"), HTML)
  write(join(dist, "assets", "index-AbCd12_-.js"), "console.log(1)\n")
  write(join(dist, "assets", "index-Zz99yy00.css"), "body{}\n")
  write(join(dist, "icons", "icon-32.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  write(join(dist, "icons", "icon-64.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(dist, "index.html"), later, later)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const stageDir = () => join(desktop, STAGE_FOLDER)

describe("stage + check (U-MAN-03)", () => {
  test("a fresh build stages to pane/ and manifest/ and passes", async () => {
    await stage(desktop)
    expect(await checkStage(desktop)).toEqual([])
    expect(await Bun.file(join(stageDir(), "manifest", OFFICE_MANIFEST_FILE)).text()).toBe(REAL_MANIFEST)
    expect(await Bun.file(join(stageDir(), "pane", "index.html")).text()).toBe(HTML)
  })

  test("no stage folder fails", async () => {
    expect((await checkStage(desktop)).join("\n")).toContain("folder missing")
  })

  test("a staged manifest that differs from the source by one byte fails", async () => {
    await stage(desktop)
    writeFileSync(join(stageDir(), "manifest", OFFICE_MANIFEST_FILE), REAL_MANIFEST + " ")
    expect((await checkStage(desktop)).join("\n")).toContain("differs from the source manifest")
  })

  test("an extra file in manifest/ or at the top fails", async () => {
    await stage(desktop)
    write(join(stageDir(), "manifest", "other.xml"), "<x/>")
    write(join(stageDir(), "stray.txt"), "x")
    const lines = (await checkStage(desktop)).join("\n")
    expect(lines).toContain("manifest/ must hold only")
    expect(lines).toContain("unexpected top-level entries: stray.txt")
  })
})

describe("SD §12.1 manifest and page rules", () => {
  for (const [label, edit, message] of [
    ["SourceLocation", (xml: string) => xml.replace("https://localhost:46317/pane/index.html\"/>\n  </DefaultSettings>", "https://localhost:46318/pane/index.html\"/>\n  </DefaultSettings>"), "<SourceLocation>"],
    ["Id", (xml: string) => xml.replace("b25aaa4e-a1e7-46ef-bba0-0139b2a424b9", "00000000-a1e7-46ef-bba0-0139b2a424b9"), "<Id>"],
    ["Requirements", (xml: string) => xml.replace("<Permissions>", "<Requirements><Sets/></Requirements>\n  <Permissions>"), "<Requirements>"],
  ] as const) {
    test(`a wrong ${label} in the source fails the stage`, async () => {
      write(join(addin, "manifest", OFFICE_MANIFEST_FILE), edit(REAL_MANIFEST))
      const later = new Date(Date.now() + 60_000)
      utimesSync(join(dist, "index.html"), later, later)
      await stage(desktop)
      expect((await checkStage(desktop)).join("\n")).toContain(message)
    })
  }

  test("the real manifest passes the SD §12.1 rules", async () => {
    await stage(desktop)
    expect((await checkStage(desktop)).filter((line) => /SourceLocation|<Id>|Requirements/.test(line))).toEqual([])
  })

  test("Office.js from any other URL, a second external script or none fails", () => {
    expect(checkPaneHtml(HTML)).toEqual([])
    expect(checkPaneHtml(HTML.replace(OFFICE_JS_URL, "https://appsforoffice.microsoft.com/lib/1/hosted/office.js"))).toHaveLength(1)
    expect(checkPaneHtml(HTML.replace("<link", `<script src="https://evil.example/x.js"></script><link`))).toHaveLength(1)
    expect(checkPaneHtml(HTML.replace(`<script src="${OFFICE_JS_URL}"></script>`, ""))).toHaveLength(1)
  })
})

describe("C26(b) hashed assets and manifest Version policy", () => {
  test("an asset without a content hash fails", async () => {
    write(join(dist, "assets", "plain.js"), "x")
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("pane/assets/plain.js has no content hash")
  })

  test("the manifest Version must match the row of the current release", () => {
    expect(checkVersionPolicy("1.0.0.0", "1.3.1", [{ release: "1.3.1", version: "1.0.0.0" }])).toEqual([])
    expect(checkVersionPolicy("1.0.0.0", "1.3.1", [{ release: "1.3.1", version: "1.0.1.0" }])).toEqual([
      "manifest <Version> 1.0.0.0 is not 1.0.1.0 (release 1.3.1)",
    ])
  })

  test("a release bump without a new row fails: bump per release", () => {
    expect(checkVersionPolicy("1.0.0.0", "1.3.2", [{ release: "1.3.1", version: "1.0.0.0" }]).join()).toContain(
      "release 1.3.2 has no MANIFEST_VERSIONS row",
    )
  })

  test("rows must strictly increase and be four-part", () => {
    const rows = [
      { release: "1.3.1", version: "1.0.1.0" },
      { release: "1.3.2", version: "1.0.0.0" },
    ]
    expect(checkVersionPolicy("1.0.0.0", "1.3.2", rows).join()).toContain("must increase")
    expect(checkVersionPolicy("1.0.0", "1.3.1", [{ release: "1.3.1", version: "1.0.0" }]).join()).toContain("not four-part")
  })

  test("a desktop release with no row fails the stage check", async () => {
    write(join(desktop, "package.json"), JSON.stringify({ version: "9.9.9" }))
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("release 9.9.9 has no MANIFEST_VERSIONS row")
  })
})

describe("C52 / F-5, E7 and the size ceiling", () => {
  test("a staged source map fails", async () => {
    write(join(dist, "assets", "index-AbCd12_-.js.map"), "{}")
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("is a source map (C52)")
  })

  test("an executable bit, a Mach-O or a #! file fails", async () => {
    await stage(desktop)
    chmodSync(join(stageDir(), "pane", "icons", "icon-32.png"), 0o755)
    write(join(stageDir(), "pane", "assets", "tool-AAAAAAAA.bin"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
    write(join(stageDir(), "pane", "assets", "run-BBBBBBBB.sh"), "#!/bin/sh\n")
    const lines = (await checkStage(desktop)).join("\n")
    expect(lines).toContain("icon-32.png has an executable bit")
    expect(lines).toContain("tool-AAAAAAAA.bin is a Mach-O binary")
    expect(lines).toContain("run-BBBBBBBB.sh is a script (#!)")
  })

  test("staging writes every file mode 644", async () => {
    chmodSync(join(dist, "icons", "icon-64.png"), 0o755)
    await stage(desktop)
    expect((await checkStage(desktop)).filter((line) => line.includes("executable"))).toEqual([])
  })

  test("a symlink fails", async () => {
    await stage(desktop)
    symlinkSync("/etc/hosts", join(stageDir(), "pane", "assets", "link-CCCCCCCC.js"))
    expect((await checkStage(desktop)).join("\n")).toContain("link-CCCCCCCC.js is a symlink or special file")
  })

  test("more than 5 MB fails", async () => {
    write(join(dist, "assets", "big-DDDDDDDD.js"), Buffer.alloc(CEILING_BYTES + 1, 0x20))
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("byte ceiling")
  })
})

describe("F-6 missing or stale dist/pane", () => {
  test("a missing dist/pane fails", async () => {
    rmSync(dist, { recursive: true })
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("dist/pane is missing")
  })

  test("a source newer than the build fails", async () => {
    const later = new Date(Date.now() + 120_000)
    utimesSync(join(addin, "src", "index.tsx"), later, later)
    await stage(desktop)
    expect((await checkStage(desktop)).join("\n")).toContain("dist/pane is older than ../office-addin/src/index.tsx")
  })

  test("a newer test file is not a build input", async () => {
    const later = new Date(Date.now() + 120_000)
    utimesSync(join(addin, "src", "views", "a.test.ts"), later, later)
    await stage(desktop)
    expect(await checkStage(desktop)).toEqual([])
  })

  test("a stage older than dist/pane fails", async () => {
    await stage(desktop)
    write(join(dist, "assets", "index-AbCd12_-.js"), "console.log(2)\n")
    expect((await checkStage(desktop)).join("\n")).toContain("assets/index-AbCd12_-.js differs between dist/pane")
  })
})

describe("verify (afterPack, IM-19)", () => {
  test("Resources/office-addin equal to the stage passes; a changed or missing file fails", async () => {
    await stage(desktop)
    const resources = join(root, "Resources")
    mkdirSync(resources)
    await Bun.$`cp -R ${stageDir()} ${join(resources, "office-addin")}`.quiet()
    expect(await checkResources(resources, desktop)).toEqual([])
    writeFileSync(join(resources, "office-addin", "pane", "assets", "index-Zz99yy00.css"), "body{color:red}")
    rmSync(join(resources, "office-addin", "pane", "icons", "icon-64.png"))
    const lines = (await checkResources(resources, desktop)).join("\n")
    expect(lines).toContain("differs between .office-addin-stage and Resources/office-addin")
    expect(lines).toContain("only in .office-addin-stage: pane/icons/icon-64.png")
  })

  test("no Resources/office-addin fails", async () => {
    await stage(desktop)
    expect((await checkResources(join(root, "Resources"), desktop)).join("\n")).toContain("folder missing")
  })
})

// U-DT-09 (U5 guard): the stage reaches the package for darwin-arm64 only, and only there does afterPack verify it.
describe("U-DT-09 builder config", () => {
  const entry = { from: ".office-addin-stage", to: "office-addin" }
  async function load(target: string | undefined) {
    const previous = process.env.SWARM_BUILD_TARGET
    if (target === undefined) delete process.env.SWARM_BUILD_TARGET
    if (target !== undefined) process.env.SWARM_BUILD_TARGET = target
    const module = await import(`../electron-builder.config.ts?u-dt-09=${target ?? "unset"}`)
    if (previous === undefined) delete process.env.SWARM_BUILD_TARGET
    if (previous !== undefined) process.env.SWARM_BUILD_TARGET = previous
    return module.default as Configuration
  }

  for (const target of [undefined, "darwin-arm64"]) {
    test(`stages the add-in for ${target ?? "an unset target"} (darwin-arm64)`, async () => {
      const config = await load(target)
      expect(config.extraResources).toContainEqual(entry)
    })
  }

  for (const target of ["linux-x64", "win32-x64"]) {
    test(`does not stage the add-in for ${target}`, async () => {
      const config = await load(target)
      const resources = config.extraResources as { from: string }[]
      expect(resources.map((item) => item.from)).not.toContain(entry.from)
      expect(JSON.stringify(config)).not.toContain("office-addin")
    })
  }

  // M9-01b (CP-M9 N-1): the composed afterPack itself, per target. The config is copied into a temp package dir so
  // the library hook's cleanup removes a temp .library-stage, never the real one; a spy `bun` records each gate call.
  test("the configured afterPack runs the office verify on darwin-arm64 only", async () => {
    const pkg = join(root, "pkg")
    const copy = join(pkg, "electron-builder.config.ts")
    write(copy, await Bun.file(join(import.meta.dir, "..", "electron-builder.config.ts")).text())
    const bin = join(root, "spy-bin")
    const log = join(root, "after.log")
    write(join(bin, "bun"), `#!/bin/sh\necho "$@" >> "${log}"\n`)
    chmodSync(join(bin, "bun"), 0o755)
    const savedPath = process.env.PATH
    const savedTarget = process.env.SWARM_BUILD_TARGET
    const calls: Record<string, string[]> = {}
    for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
      process.env.SWARM_BUILD_TARGET = target
      const config = (await import(`${copy}?n1=${target}`)).default as Configuration
      process.env.PATH = `${bin}:${savedPath}`
      rmSync(log, { force: true })
      await (config.afterPack as (context: unknown) => Promise<void>)({ appOutDir: "/out", packager: { getResourcesDir: () => "/out/Res" } })
      process.env.PATH = savedPath
      calls[target] = (await Bun.file(log).text()).trim().split("\n").map((line) => line.split(" ")[0]!.split("/").at(-1)!)
    }
    if (savedTarget === undefined) delete process.env.SWARM_BUILD_TARGET
    if (savedTarget !== undefined) process.env.SWARM_BUILD_TARGET = savedTarget
    expect(calls["darwin-arm64"]).toEqual(["stage-library.ts", "check-datum-stage.ts", "check-office-addin-stage.ts"])
    expect(calls["linux-x64"]).toEqual(["stage-library.ts", "check-datum-stage.ts"])
    expect(calls["win32-x64"]).toEqual(["stage-library.ts", "check-datum-stage.ts"])
  })

  test("the config never imports the Bun-only gate script", async () => {
    const source = await Bun.file(join(import.meta.dir, "..", "electron-builder.config.ts")).text()
    expect(source).not.toMatch(/(from|import\()\s*["'][^"']*(check-office-addin-stage|stage-office-addin)/)
  })

  test("officeAddinHooks afterPack runs the verify mode on the packaged Resources", async () => {
    const { officeAddinHooks } = await import("../electron-builder.config")
    const bin = join(root, "bin")
    const log = join(root, "spy.log")
    write(join(bin, "bun"), `#!/bin/sh\necho "$@" >> "${log}"\n`)
    chmodSync(join(bin, "bun"), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
    const hooks = officeAddinHooks("/x/check-office-addin-stage.ts")
    await hooks.beforePack()
    await hooks.afterPack({ appOutDir: "/out", packager: { getResourcesDir: () => "/out/Res" } })
    process.env.PATH = saved
    expect((await Bun.file(log).text()).trim()).toBe("/x/check-office-addin-stage.ts verify /out/Res")
  })
})
