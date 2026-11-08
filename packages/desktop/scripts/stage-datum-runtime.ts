#!/usr/bin/env bun
// Stages Resources/datum-runtime for DATUM's Python scripts (1.2.0 row 23; runtime spec §1-2, packaging spec §2.4 and §3).
// Built from the pinned python-build-standalone tarball and hash-pinned wheels, cached in tools/build/datum_runtime_cache
// so a second run needs no network. Adds the datum-render-shim wheel (row 106), bin/datum-python (-I -B), bin/rsvg-convert,
// the datum-house-style.pth, prunes (spec §1.3 + packaging §2.4 rule 4 + probe F4/F5), thins lxml to arm64 and writes
// runtime-manifest.json. Never writes .pyc: every staged-python call runs -I -B (probe F1). The stage folder is replaced
// only when every check passes.
// Signing (row 52a, C111; replaces packaging §2.4 rule 1): the stage signs its 35 Mach-O itself, ad hoc, with the
// hardened runtime and the app's inherit entitlements (the same codesign call osx-sign makes), BEFORE the smoke test and
// the manifest. electron-builder skips Res/datum-runtime (mac.signIgnore, electron-builder.config.ts), so the shipped
// bytes equal the manifest's size and sha256 for every file, Mach-O included, and the smoke test runs the signed state.
// Row 122 (linux/windows installer task; spec 113 §3 S3 and §4, register R2.8, R2.9, R5.13, R12.3, R12.4, D-W8):
// SWARM_BUILD_TARGET=linux-x64 stages the x86_64-unknown-linux-gnu interpreter and the manylinux_2_28 wheels on this
// Mac. The staged python cannot run here, so the wheels are installed by unzip (installWheelByUnzip, laid out as pip
// --target lays them out), the shim wheel is built by the pinned darwin interpreter from the same cache, nothing is
// thinned or signed, the native kind is `elf` (ELF_EXPECTED) and the import smoke is static (LP-23 runs it in colima).
// SWARM_BUILD_TARGET unset (or empty) is darwin-arm64 and runs exactly the steps above, unchanged.
//
//   bun scripts/stage-datum-runtime.ts [--out DIR] [--cache DIR] [--offline]
import { $ } from "bun"
import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { crc32, inflateRawSync } from "node:zlib"
import { buildTarget, type BuildTarget } from "./prebuild-target"

const DESKTOP = path.resolve(import.meta.dir, "..")
export const STAGE = path.join(DESKTOP, ".datum-runtime-stage")
// Register line 82: tools/build/datum_runtime_cache, beside the swarm repo (Swarm_OnDevice/tools).
const DEFAULT_CACHE = path.resolve(DESKTOP, "..", "..", "..", "tools", "build", "datum_runtime_cache")
const SKILL = path.join(DESKTOP, "datum", "datum-house-style")
const SHIM = path.join(DESKTOP, "datum", "datum-render-shim")

export const PYTHON = {
  version: "3.14.10",
  release: "20261026",
  file: "cpython-3.14.10+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.14.10%2B20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
  size: 26753457,
  sha256: "95eb8c87d16af37c54e9765e31d8c56c0d8ffa9968ea0f704f73a9b83f84e9f9",
} as const

const PYPI = "https://files.pythonhosted.org/packages"
// Row 15 lock (research/09 §2), identical to test/judge/requirements.lock minus pymupdf. No matplotlib (K5).
export const WHEELS = [
  { name: "et-xmlfile", version: "2.0.0", file: "et_xmlfile-2.0.0-py3-none-any.whl", size: 18059, sha256: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa", url: `${PYPI}/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl` },
  { name: "lxml", version: "6.1.3", file: "lxml-6.1.3-cp314-cp314-macosx_10_15_universal2.whl", size: 8609725, sha256: "2bec13085dc8ef48a3fe62f7dfcacfeda2c785cdf19cc8eeda2bb9ed081da165", url: `${PYPI}/0c/15/fc75a70b0af6021d0ea16811f1fc71cc42cd06ce90fe10f007a69b2eed84/lxml-6.1.3-cp314-cp314-macosx_10_15_universal2.whl` },
  { name: "openpyxl", version: "3.1.5", file: "openpyxl-3.1.5-py2.py3-none-any.whl", size: 250910, sha256: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2", url: `${PYPI}/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl` },
  { name: "pillow", version: "13.0.0", file: "pillow-13.0.0-cp314-cp314-macosx_11_0_arm64.whl", size: 4852269, sha256: "d9b0a2bee3f3e03e9f29057aedb807dbf1e1d96ee1b9d0f422d9db6c8583271d", url: `${PYPI}/b5/f4/0bf6f1ac9ba7ee2ffe9914aeb410a1035a0c1a3c42f122388d7fc950bc4b/pillow-13.0.0-cp314-cp314-macosx_11_0_arm64.whl` },
  { name: "python-docx", version: "1.2.0", file: "python_docx-1.2.0-py3-none-any.whl", size: 252987, sha256: "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7", url: `${PYPI}/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl` },
  { name: "python-pptx", version: "1.0.2", file: "python_pptx-1.0.2-py3-none-any.whl", size: 472788, sha256: "160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba", url: `${PYPI}/d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49/python_pptx-1.0.2-py3-none-any.whl` },
  { name: "typing-extensions", version: "4.16.0", file: "typing_extensions-4.16.0-py3-none-any.whl", size: 45571, sha256: "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8", url: `${PYPI}/49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl` },
  { name: "xlsxwriter", version: "3.3.1", file: "xlsxwriter-3.3.1-py3-none-any.whl", size: 180583, sha256: "8e2c89e59d733fe59e112317218c64fbbc276d90a8c144ebd6f7fa15e7ab184a", url: `${PYPI}/88/eb/1e6af9959a567901a7e7c7cef2e75883e487df223ed67f9a8977ff863bd8/xlsxwriter-3.3.1-py3-none-any.whl` },
] as const

// Row 106: reproducible local wheel built by datum/datum-render-shim/build_wheel.py (implementation/08_row106_render_shim.md).
export const SHIM_WHEEL = {
  name: "datum-render-shim",
  version: "1.2.0",
  file: "datum_render_shim-1.2.0-py3-none-any.whl",
  sha256: "8ff4b4a8599c01403cdb078954ae8014f357ff17974a4461864b2a88c45c18e7",
} as const

const PY_LIB = "lib/python3.14"
const SITE = `python/${PY_LIB}/site-packages`
// Res/datum-runtime/python/lib/python3.14/site-packages -> 5 levels up is Res (runtime spec §1.6, probe F2/F3).
export const PTH = { name: "datum-house-style.pth", line: "../../../../../datum-house-style/scripts" }
// Row 141a (C171): the runtime manifest release follows packages/desktop/package.json `version` (stage, check and test all read this).
export const RELEASE: string = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")).version
export const MACHO_EXPECTED = 35// research/09 §7, packaging §2.4 rule 3, recipe DATUM_MACHO
// Row 52a: the plist electron-builder gives every nested path (mac.entitlementsInherit); the config test pins the pair.
export const ENTITLEMENTS = path.join(DESKTOP, "resources", "entitlements.plist")
// osx-sign's per-file call (OS/sign.js:174, :229-266) with an explicit --timestamp=none: an ad-hoc signature carries no
// timestamp, so this keeps the stage offline and deterministic.
export const codesignArgs = (file: string) =>
  ["--sign", "-", "--force", "--timestamp=none", "--options", "runtime", "--entitlements", ENTITLEMENTS, file]
// After the prune only these stay in python/bin and python/lib (allow-list; everything else there is removed).
const KEEP_BIN = ["python", "python3", "python3.14"]
const KEEP_LIB = ["python3.14"]
// Removed inside python/ (spec §1.3 + packaging §2.4 rule 4 + F4 libpython + F5 pip + _tkinter).
const PRUNE_TOP = ["include", "share"]
const PRUNE_STDLIB = ["idlelib", "tkinter", "turtledemo", "ensurepip", "config-3.14-darwin", "test", "lib2to3"]

// Row 122: linux-x64 pins. Interpreter: register R5.13 / research 02_collection_python_cross.md:20 (row 103). lxml and
// pillow: spec 113 §4 (PyPI JSON digests, row 103 §2; the files pip resolved for manylinux_2_28 in row 108). The six
// pure wheels and the shim are the darwin entries above, unchanged.
export const PYTHON_LINUX = {
  version: "3.14.10",
  release: "20261026",
  file: "cpython-3.14.10+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.14.10%2B20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  size: 36776589,
  sha256: "4d3c16c59ed0802a3d1d34d8bce504b15ceeaff39d62dadecc6a9fa803412aed",
} as const
const LINUX_NATIVE_WHEELS = {
  lxml: { name: "lxml", version: "6.1.3", file: "lxml-6.1.3-cp314-cp314-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl", size: 5245991, sha256: "a7eb78ba28b187e1e9203a55c60fcf70df2d22cb205fe6d51b9383d6097419f0", url: `${PYPI}/e9/44/27e3cee3dcdb3b7bc09727b642bdbfcd098490ea77df04611db9060d7722/lxml-6.1.3-cp314-cp314-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl` },
  pillow: { name: "pillow", version: "13.0.0", file: "pillow-13.0.0-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", size: 7142574, sha256: "e91c2b1cbeae768c98752e67e717e283d68dae45717b41f2d91eaee648e37b7d", url: `${PYPI}/1d/f2/1371707ce438ba9a43f9d24089828494ec6f9396e28cd7903aa704dd6306/pillow-13.0.0-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl` },
} as const
export const WHEELS_LINUX = WHEELS.map((w) => (w.name === "lxml" || w.name === "pillow" ? LINUX_NATIVE_WHEELS[w.name] : w))
// R12.3: the ELF regular files the linux-x64 stage ships (recorded by row 122's stage run; check-datum-stage reads it).
export const ELF_EXPECTED = 35
// Row 108 / L15 (register R2.9): wheels up to manylinux_2_28, so no staged ELF may need a GLIBC_2.N symbol above 2.28.
export const GLIBC_FLOOR_MINOR = 28
const LINUX_SO_TAG = "cpython-314-x86_64-linux-gnu"
// The darwin smoke's imports that this stage installs (site-packages) or links (skill scripts via the .pth).
export const LINUX_SITE_IMPORTS = ["docx", "openpyxl", "pptx", "lxml", "lxml.etree", "PIL", "PIL.Image", "PIL._imaging", "PIL._imagingft", "xlsxwriter", "et_xmlfile", "typing_extensions", "playwright.sync_api", "datum_render_shim"]
export const LINUX_SKILL_IMPORTS = ["datumbind", "datumcheck", "embed_fonts", "datum_symbols", "datumchart"]

type RuntimePlan = {
  target: BuildTarget
  python: { version: string; release: string; file: string; url: string; size: number; sha256: string }
  wheels: ReadonlyArray<{ name: string; version: string; file: string; size: number; sha256: string; url: string }>
  lockFile: string
  pruneStdlib: string[]
}
/** The pins and names of one build target (row 122: darwin-arm64 = the tables above, unchanged; linux-x64). */
export function runtimePlan(target: BuildTarget): RuntimePlan {
  if (target === "darwin-arm64") return { target, python: PYTHON, wheels: WHEELS, lockFile: "requirements.lock", pruneStdlib: PRUNE_STDLIB }
  if (target === "linux-x64")
    return {
      target,
      python: PYTHON_LINUX,
      wheels: WHEELS_LINUX,
      // A separate lock file: the darwin requirements.lock in the shared cache stays byte-identical.
      lockFile: "requirements-linux-x64.lock",
      pruneStdlib: PRUNE_STDLIB.map((n) => (n === "config-3.14-darwin" ? "config-3.14-x86_64-linux-gnu" : n)),
    }
  fail(`target ${target} is not staged by this script yet (row 123)`)
}

export const LAUNCHER = `#!/bin/sh
# datum-python: the bundled interpreter for DATUM's scripts (runtime spec 1.6; register datum-runtime/bin/).
# Written by scripts/stage-datum-runtime.ts. {{DATUM_PYTHON}} resolves to this file.
# -I: no PYTHON* variables, no user site, neither cwd nor the script folder on sys.path; the skill scripts come
#     from site-packages/datum-house-style.pth (research/09 F2/F3).
# -B: no .pyc. Under -I only -B stops bytecode writes (research/09 F1), so the sealed app is never written.
# PATH puts this folder first, so the bundled rsvg-convert shim always wins over a Homebrew rsvg-convert or inkscape.
# DATUM_OUT, DATUM_RENDER_SOCKET and DATUM_RENDER_TOKEN pass through unchanged.
self=$(/usr/bin/readlink -f "$0") || exit 1
here=$(/usr/bin/dirname "$self")
PATH="$here:/usr/bin:/bin"
export PATH
exec "$here/../python/bin/python3" -I -B "$@"
`

class StageFail extends Error {}
function fail(message: string): never {
  throw new StageFail(message)
}

type Args = { out: string; cache: string; offline: boolean }
function parseArgs(argv: string[]): Args {
  const args: Args = { out: STAGE, cache: process.env.DATUM_RUNTIME_CACHE || DEFAULT_CACHE, offline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--offline") args.offline = true
    else if (a === "--out" && argv[i + 1]) args.out = path.resolve(argv[++i])
    else if (a === "--cache" && argv[i + 1]) args.cache = path.resolve(argv[++i])
    else fail(`unknown argument ${a} (use --out DIR, --cache DIR, --offline)`)
  }
  return args
}

async function sha256File(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

async function exists(p: string) {
  return fs.lstat(p).then(
    () => true,
    () => false,
  )
}

// A cached file is used only when its size and sha256 match the pin. Otherwise it is fetched over https (GitHub release
// or files.pythonhosted.org only), checked, and only then moved into the cache.
async function cached(cache: string, rel: string, pin: { url: string; size: number; sha256: string }, offline: boolean) {
  const target = path.join(cache, rel)
  if (await exists(target)) {
    const st = await fs.stat(target)
    if (st.size === pin.size && (await sha256File(target)) === pin.sha256) return { file: target, fetched: false }
    fail(`cache file ${rel} does not match its pin (size ${st.size}); move it aside and rerun`)
  }
  if (offline) fail(`cache file ${rel} missing and --offline given`)
  const host = new URL(pin.url).host
  if (host !== "github.com" && host !== "files.pythonhosted.org") fail(`refusing host ${host}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const part = `${target}.part-${process.pid}`
  const r = await $`/usr/bin/curl -fsSL --proto =https --proto-redir =https --retry 2 -o ${part} ${pin.url}`.nothrow().quiet()
  if (r.exitCode !== 0) {
    await fs.rm(part, { force: true })
    fail(`download ${rel} exit ${r.exitCode}: ${r.stderr.toString().trim()}`)
  }
  const st = await fs.stat(part)
  const got = await sha256File(part)
  if (st.size !== pin.size || got !== pin.sha256) {
    await fs.rm(part, { force: true })
    fail(`download ${rel} size ${st.size} sha256 ${got} does not match the pin`)
  }
  await fs.rename(part, target)
  return { file: target, fetched: true }
}

function lockText(wheels: RuntimePlan["wheels"] = WHEELS, header = "# datum-runtime 1.2.0 lock (scripts/stage-datum-runtime.ts; row 15 pins, research/09 §2)") {
  return [
    header,
    ...[...wheels].sort((a, b) => a.name.localeCompare(b.name)).map((w) => `${w.name}==${w.version} --hash=sha256:${w.sha256}`),
    "",
  ].join("\n")
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  for (const name of (await fs.readdir(path.join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name
    const st = await fs.lstat(path.join(root, r))
    out.push(r)
    if (st.isDirectory()) out.push(...(await walk(root, r)))
  }
  return out
}

async function isMachO(file: string) {
  const fh = await fs.open(file, "r")
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    if (bytesRead < 4) return false
    const m = buf.readUInt32BE(0)
    // thin 64/32-bit (either byte order) and fat (universal) headers
    return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(m)
  } finally {
    await fh.close()
  }
}

// ---- Row 122: linux-x64 helpers (never called for darwin-arm64) ----

/** Native kind by header, the rule check-datum-stage.ts nativeOf uses: Mach-O magics, \x7fELF (+ x86-64), MZ + PE\0\0. */
export async function nativeKind(file: string): Promise<{ kind: "macho" | "elf" | "pe"; x64: boolean } | null> {
  const fh = await fs.open(file, "r")
  try {
    const head = Buffer.alloc(64)
    const { bytesRead } = await fh.read(head, 0, 64, 0)
    if (bytesRead >= 4 && [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0)))
      return { kind: "macho", x64: false }
    if (bytesRead >= 20 && head.readUInt32BE(0) === 0x7f454c46) {
      const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18)
      return { kind: "elf", x64: head[4] === 2 && machine === 0x3e }
    }
    if (bytesRead >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const pe = Buffer.alloc(6)
      const read = await fh.read(pe, 0, 6, head.readUInt32LE(0x3c))
      if (read.bytesRead === 6 && pe.readUInt32BE(0) === 0x50450000) return { kind: "pe", x64: pe.readUInt16LE(4) === 0x8664 }
    }
    return null
  } finally {
    await fh.close()
  }
}

/** Highest GLIBC_2.N symbol version named in an ELF (its version-need strings); -1 when none. */
export function glibcMaxMinor(bytes: Buffer): number {
  let max = -1
  for (const m of bytes.toString("latin1").matchAll(/GLIBC_2\.(\d+)/g)) max = Math.max(max, Number(m[1]))
  return max
}

type ZipEntry = { name: string; method: number; crc: number; csize: number; usize: number; offset: number; attr: number }

/** Central directory of a (non-zip64) zip, as wheels are. */
export function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) fail("zip: no end of central directory")
  const count = buf.readUInt16LE(eocd + 10)
  const start = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || start === 0xffffffff) fail("zip: zip64 is not supported")
  const out: ZipEntry[] = []
  let p = start
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail(`zip: bad central directory entry ${i}`)
    const nlen = buf.readUInt16LE(p + 28)
    out.push({
      name: buf.toString("utf8", p + 46, p + 46 + nlen),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      attr: buf.readUInt32LE(p + 38),
      offset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

/** One entry's bytes, size- and CRC-checked (stored or deflate only). */
export function zipData(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) fail(`zip: bad local header for ${e.name}`)
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
  const raw = buf.subarray(start, start + e.csize)
  const data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? inflateRawSync(raw) : fail(`zip: method ${e.method} for ${e.name}`)
  if (data.length !== e.usize || crc32(data) >>> 0 !== e.crc >>> 0) fail(`zip: size or CRC mismatch for ${e.name}`)
  return data
}

const recordDigest = (data: Buffer) => `sha256=${createHash("sha256").update(data).digest("base64url")}`
function recordField(value: string) {
  // pip writes RECORD with csv.writer (QUOTE_MINIMAL); none of the pinned wheels needs quoting, so refuse instead.
  if (/[",\r\n]/.test(value)) fail(`RECORD field needs csv quoting: ${JSON.stringify(value)}`)
  return value
}

/**
 * Install one wheel into `site` the way `pip install --no-deps --no-compile --target site` lays it out (pip 26.2.2,
 * operations/install/wheel.py): purelib/platlib files at the root, `.data/scripts` under site/bin (removed by the prune
 * as on darwin), mode 755 for entries with an exec bit and 644 otherwise, every RECORD hash verified, INSTALLER `pip\n`
 * and an empty REQUESTED added, and RECORD rewritten as pip writes it (rows sorted, CRLF). Never executes anything.
 */
export async function installWheelByUnzip(wheelFile: string, site: string): Promise<string> {
  const buf = await fs.readFile(wheelFile)
  const entries = zipEntries(buf).filter((e) => !e.name.endsWith("/"))
  const infoDirs = [...new Set(entries.map((e) => e.name.split("/")[0]).filter((n) => n.endsWith(".dist-info")))]
  if (infoDirs.length !== 1) fail(`${path.basename(wheelFile)}: expected one .dist-info, found ${infoDirs.length}`)
  const info = infoDirs[0]
  const dataDir = info.replace(/\.dist-info$/, ".data")
  const byName = new Map(entries.map((e) => [e.name, e]))
  const meta = (name: string) => {
    const e = byName.get(`${info}/${name}`)
    if (!e) fail(`${path.basename(wheelFile)}: ${info}/${name} missing`)
    return zipData(buf, e).toString("utf8")
  }
  if (!/^Wheel-Version: 1\./m.test(meta("WHEEL"))) fail(`${path.basename(wheelFile)}: Wheel-Version is not 1.x`)
  const oldRows = meta("RECORD")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      if (line.includes('"')) fail(`${path.basename(wheelFile)}: quoted RECORD row ${line}`)
      return line.split(",")
    })
  const hashes = new Map(oldRows.map((row) => [row[0], row[1] ?? ""]))

  const installed = new Map<string, string>() // archive RECORD path -> installed RECORD path
  for (const e of entries) {
    const parts = e.name.split("/")
    if (e.name.startsWith("/") || e.name.includes("\\") || parts.some((p) => p === ".." || p === "." || p === ""))
      fail(`${path.basename(wheelFile)}: unsafe entry ${e.name}`)
    let dest = e.name
    let recordPath = e.name
    if (parts[0] === dataDir) {
      const [kind, ...rest] = parts.slice(1)
      if (kind === "purelib" || kind === "platlib") dest = recordPath = rest.join("/")
      else if (kind === "scripts") {
        // pip --target: the file lands in site/bin, its RECORD row reads ../../bin/<name> (pip 26.2.2, checked by row 122)
        dest = ["bin", ...rest].join("/")
        recordPath = ["..", "..", "bin", ...rest].join("/")
      } else fail(`${path.basename(wheelFile)}: .data/${kind} is not supported`)
    }
    const data = zipData(buf, e)
    const want = hashes.get(e.name)
    if (want && want !== recordDigest(data)) fail(`${path.basename(wheelFile)}: RECORD hash mismatch for ${e.name}`)
    if (!want && e.name !== `${info}/RECORD`) fail(`${path.basename(wheelFile)}: ${e.name} has no RECORD hash`)
    const abs = path.join(site, ...dest.split("/"))
    if (await exists(abs)) fail(`${path.basename(wheelFile)}: ${dest} already installed by another wheel`)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const exec = ((e.attr >>> 16) & 0o170000) === 0o100000 && ((e.attr >>> 16) & 0o111) !== 0
    await fs.writeFile(abs, data)
    await fs.chmod(abs, exec ? 0o755 : 0o644)
    if (e.name !== `${info}/RECORD`) installed.set(e.name, recordPath)
  }

  const rows: string[][] = []
  for (const row of oldRows) {
    const dest = installed.get(row[0]) ?? row[0]
    installed.delete(row[0])
    rows.push([dest, row[1] ?? "", row[2] ?? ""])
  }
  for (const [name, text] of [["INSTALLER", "pip\n"], ["REQUESTED", ""]] as const) {
    const data = Buffer.from(text)
    await fs.writeFile(path.join(site, info, name), data)
    await fs.chmod(path.join(site, info, name), 0o644)
    rows.push([`${info}/${name}`, recordDigest(data), String(data.length)])
  }
  for (const dest of installed.values()) rows.push([dest, "", ""])
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
  const record = path.join(site, info, "RECORD")
  await fs.writeFile(record, rows.map((row) => `${row.map(recordField).join(",")}\r\n`).join(""))
  await fs.chmod(record, 0o644)
  return info.replace(/\.dist-info$/, "")
}

/** A dotted module resolves under root as a package, a .py file or a linux extension module (static smoke, row 122). */
export async function moduleFile(root: string, mod: string) {
  const base = path.join(root, ...mod.split("."))
  for (const f of [path.join(base, "__init__.py"), `${base}.py`, `${base}.${LINUX_SO_TAG}.so`, `${base}.abi3.so`]) if (await exists(f)) return f
  return null
}

type StageFile = { path: string; kind: "macho" | "elf" | "data" | "symlink"; mode: string; size?: number; sha256?: string; target?: string }

/** Row 122: linux-x64 steps 10-11 - ELF count and glibc floor, the manifest (kind `elf`, counts.elf), then the output. */
async function finishLinux(args: Args, rt: string, files: StageFile[], bytes: number, pruned: string[]) {
  const elf = files.filter((f) => f.kind === "elf")
  if (elf.length !== ELF_EXPECTED) fail(`${elf.length} ELF files, expected ${ELF_EXPECTED}`)
  let glibc = -1
  for (const f of elf) {
    const minor = glibcMaxMinor(await fs.readFile(path.join(rt, f.path)))
    if (minor > GLIBC_FLOOR_MINOR) fail(`${f.path} needs GLIBC_2.${minor}, above the 2.${GLIBC_FLOOR_MINOR} floor`)
    glibc = Math.max(glibc, minor)
  }
  const manifest = {
    schema: 1,
    name: "datum-runtime",
    version: RELEASE,
    target: "linux-x64",
    python: { version: PYTHON_LINUX.version, release: PYTHON_LINUX.release, asset: PYTHON_LINUX.file, sha256: PYTHON_LINUX.sha256 },
    wheels: [...WHEELS_LINUX.map(({ name, version, file, sha256 }) => ({ name, version, file, sha256 })), { ...SHIM_WHEEL }],
    install: "unzip (pip --target layout; D-W8)",
    launcher: "bin/datum-python",
    pth: { path: `${SITE}/${PTH.name}`, line: PTH.line },
    skillSha: await sha256File(path.join(SKILL, "SKILL.md")),
    glibc: { floor: `2.${GLIBC_FLOOR_MINOR}`, highestNeeded: `2.${glibc}` },
    pruned,
    thinned: [] as string[],
    counts: { files: files.filter((f) => f.kind !== "symlink").length, elf: elf.length, symlinks: files.filter((f) => f.kind === "symlink").length, bytes },
    files,
  }
  const manifestText = `${JSON.stringify(manifest, null, 1)}\n`
  await fs.writeFile(path.join(rt, "runtime-manifest.json"), manifestText, { mode: 0o644 })
  await fs.rm(args.out, { recursive: true, force: true })
  await fs.rename(rt, args.out)
  const msha = createHash("sha256").update(manifestText).digest("hex")
  console.log(`DATUM_RUNTIME_STAGE files=${manifest.counts.files} elf=${elf.length} symlinks=${manifest.counts.symlinks} bytes=${bytes} glibc<=2.${glibc} pyc=0`)
  console.log(`DATUM_RUNTIME_STAGE manifest sha256 ${msha}`)
  console.log(`DATUM_RUNTIME_STAGE_OK ${args.out}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (process.platform !== "darwin" || process.arch !== "arm64") fail(`host ${process.platform}/${process.arch}, need darwin/arm64`)
  for (const p of [path.join(SKILL, "SKILL.md"), path.join(SHIM, "build_wheel.py"), path.join(SHIM, "bin", "rsvg-convert"), ENTITLEMENTS])
    if (!(await exists(p))) fail(`missing input ${path.relative(DESKTOP, p)}`)
  // Row 122: the build target (register R2.2; unset = darwin-arm64, whose pins and steps are unchanged).
  let target: BuildTarget
  try {
    target = buildTarget()
  } catch (error) {
    fail((error as Error).message)
  }
  const plan = runtimePlan(target)
  const linux = plan.target === "linux-x64"

  // 1. Inputs from the cache (fetch + verify if missing).
  const tarball = await cached(args.cache, plan.python.file, plan.python, args.offline)
  const wheelDir = path.join(args.cache, "wheels")
  let fetched = tarball.fetched ? 1 : 0
  for (const w of plan.wheels) if ((await cached(args.cache, `wheels/${w.file}`, w, args.offline)).fetched) fetched++
  const lockPath = path.join(args.cache, plan.lockFile)
  const lock = linux ? lockText(plan.wheels, "# datum-runtime linux-x64 lock (scripts/stage-datum-runtime.ts; row 122 pins, spec 113 §4)") : lockText()
  if (!(await exists(lockPath))) await fs.writeFile(lockPath, lock)
  else if ((await fs.readFile(lockPath, "utf8")) !== lock) fail(`cache ${plan.lockFile} differs from the pins in this script`)
  // Row 122: linux builds the shim wheel with the pinned darwin interpreter (the staged linux python cannot run here).
  const hostTarball = linux ? await cached(args.cache, PYTHON.file, PYTHON, args.offline) : null
  if (hostTarball?.fetched) fetched++
  console.log(`DATUM_RUNTIME_STAGE cache ${args.cache} fetched=${fetched}`)

  // 2. Work folder beside the output (same volume, so the final rename is atomic). Layout mimics Resources so the .pth
  //    resolves during the smoke test: <work>/Resources/{datum-runtime, datum-house-style -> skill copy}.
  await fs.mkdir(path.dirname(args.out), { recursive: true })
  const work = await fs.mkdtemp(path.join(path.dirname(args.out), ".datum-runtime-stage.tmp-"))
  try {
    const res = path.join(work, "Resources")
    const rt = path.join(res, "datum-runtime")
    const home = path.join(work, "home")
    const tmp = path.join(work, "tmp")
    for (const d of [rt, home, tmp, path.join(work, "shim")]) await fs.mkdir(d, { recursive: true })
    // Minimal env for every staged-python call: fixture HOME, dead proxy (pip runs --no-index), no host python settings.
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: tmp,
      LANG: "en_US.UTF-8",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      PIP_CONFIG_FILE: "/dev/null",
      PIP_NO_CACHE_DIR: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
    }
    const py = path.join(rt, "python", "bin", "python3")

    // 3. Extract the interpreter (tarball top folder is python/).
    const x = await $`/usr/bin/tar -xzf ${tarball.file} -C ${rt}`.env(env).nothrow().quiet()
    if (x.exitCode !== 0) fail(`tar exit ${x.exitCode}: ${x.stderr.toString().trim()}`)
    let shimPy = py
    if (linux) {
      // Row 122: the linux interpreter cannot run on this Mac; check it statically and extract the pinned darwin one
      // (outside the stage) to build the shim wheel, whose bytes the sha256 pin below still decides.
      const kind = await nativeKind(path.join(rt, "python", "bin", "python3.14")).catch(() => null)
      if (kind?.kind !== "elf" || !kind.x64) fail("staged python/bin/python3.14 is not ELF x86-64")
      if (!(await exists(path.join(rt, "python", PY_LIB, "os.py")))) fail(`staged python has no ${PY_LIB}/os.py`)
      const hostDir = path.join(work, "hostpy")
      await fs.mkdir(hostDir, { recursive: true })
      const hx = await $`/usr/bin/tar -xzf ${hostTarball!.file} -C ${hostDir}`.env(env).nothrow().quiet()
      if (hx.exitCode !== 0) fail(`tar (darwin interpreter) exit ${hx.exitCode}: ${hx.stderr.toString().trim()}`)
      shimPy = path.join(hostDir, "python", "bin", "python3")
    } else {
      const ver = (await $`${py} -I -B -c ${"import sys;print('%d.%d.%d' % sys.version_info[:3])"}`.env(env).cwd("/").nothrow().quiet()).text().trim()
      if (ver !== PYTHON.version) fail(`staged python reports ${ver}`)
    }

    // 4. Shim wheel (row 106), built by the staged interpreter, gated by its pinned sha256.
    const shimDir = path.join(work, "shim")
    const b = await $`${shimPy} -I -B ${path.join(SHIM, "build_wheel.py")} --out ${shimDir}`.env(env).cwd("/").nothrow().quiet()
    if (b.exitCode !== 0) fail(`build_wheel exit ${b.exitCode}: ${b.stderr.toString().trim()}`)
    const shimSha = await sha256File(path.join(shimDir, SHIM_WHEEL.file)).catch(() => "missing")
    if (shimSha !== SHIM_WHEEL.sha256) fail(`shim wheel sha256 ${shimSha} differs from the row 106 pin`)

    // 5. Install all nine wheels offline, hashes required, no compile, into the staged site-packages only.
    const runLock = path.join(work, "requirements.lock")
    await fs.writeFile(runLock, `${lock}${SHIM_WHEEL.name}==${SHIM_WHEEL.version} --hash=sha256:${SHIM_WHEEL.sha256}\n`)
    const site = path.join(rt, SITE)
    if (linux) {
      // Row 122 (D-W8): unzip install with pip --target's layout; every wheel file was size+sha256 checked by cached(),
      // the shim by its pin above, and installWheelByUnzip checks each member's CRC and RECORD hash.
      const names: string[] = []
      for (const w of plan.wheels) names.push(await installWheelByUnzip(path.join(wheelDir, w.file), site))
      names.push(await installWheelByUnzip(path.join(shimDir, SHIM_WHEEL.file), site))
      console.log(`DATUM_RUNTIME_STAGE unzip ${names.sort().join(" ")}`)
    } else {
      const pip =
        await $`${py} -I -B -m pip install --no-index --find-links ${wheelDir} --find-links ${shimDir} --no-deps --only-binary=:all: --require-hashes --no-compile --target ${site} -r ${runLock}`
          .env(env)
          .cwd("/")
          .nothrow()
          .quiet()
      if (pip.exitCode !== 0) fail(`pip exit ${pip.exitCode}: ${pip.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`)
      const installed = pip.stdout.toString().match(/Successfully installed (.*)/)?.[1]?.trim() ?? ""
      console.log(`DATUM_RUNTIME_STAGE pip ${installed}`)
    }

    // 6. Prune (allow-list for python/bin and python/lib, deny-list inside the stdlib), then every .pyc/__pycache__.
    const pruned: string[] = []
    const remove = async (rel: string) => {
      await fs.rm(path.join(rt, rel), { recursive: true, force: true })
      pruned.push(rel)
    }
    for (const n of (await fs.readdir(path.join(rt, "python", "bin"))).sort()) if (!KEEP_BIN.includes(n)) await remove(`python/bin/${n}`)
    for (const n of (await fs.readdir(path.join(rt, "python", "lib"))).sort()) if (!KEEP_LIB.includes(n)) await remove(`python/lib/${n}`)
    for (const n of PRUNE_TOP) if (await exists(path.join(rt, "python", n))) await remove(`python/${n}`)
    for (const n of plan.pruneStdlib) if (await exists(path.join(rt, "python", PY_LIB, n))) await remove(`python/${PY_LIB}/${n}`)
    for (const n of (await fs.readdir(path.join(rt, "python", PY_LIB, "lib-dynload"))).sort())
      if (n.startsWith("_tkinter")) await remove(`python/${PY_LIB}/lib-dynload/${n}`)
    for (const n of (await fs.readdir(site)).sort()) if (n === "pip" || /^pip-.*\.dist-info$/.test(n)) await remove(`${SITE}/${n}`)
    // pip --target writes wheel scripts (XlsxWriter's vba_extract.py) to site-packages/bin with a shebang holding this
    // build's temp path: not used by DATUM, a host-path leak, and the reason two runs differed. Drop it and its RECORD rows.
    if (await exists(path.join(site, "bin"))) {
      await remove(`${SITE}/bin`)
      for (const n of (await fs.readdir(site)).sort()) {
        const record = path.join(site, n, "RECORD")
        if (!n.endsWith(".dist-info") || !(await exists(record))) continue
        const text = await fs.readFile(record, "utf8")
        const kept = text.split("\n").filter((line) => !/^(\.\.\/)*bin\//.test(line))
        if (kept.join("\n") !== text) await fs.writeFile(record, kept.join("\n"))
      }
    }
    let pycRemoved = 0
    for (const rel of (await walk(rt)).reverse()) {
      if (path.basename(rel) === "__pycache__" || rel.endsWith(".pyc")) {
        if (!rel.endsWith("__pycache__")) pycRemoved++
        else pycRemoved += (await walk(path.join(rt, rel))).filter((f) => f.endsWith(".pyc")).length
        await fs.rm(path.join(rt, rel), { recursive: true, force: true })
      }
    }
    console.log(`DATUM_RUNTIME_STAGE pruned ${pruned.length} entries, ${pycRemoved} pyc`)

    // 7. Thin lxml's universal2 extensions to arm64 (K3; F7 closed by packaging §2.2: the arm64 slice keeps its signature).
    const thinned: string[] = []
    // Row 122: linux-x64 has nothing to thin or sign (manylinux wheels are x86-64 only; no codesign off macOS).
    if (!linux) {
      for (const rel of await walk(path.join(site, "lxml"))) {
        if (!rel.endsWith(".so")) continue
        const f = path.join(site, "lxml", rel)
        const archs = (await $`/usr/bin/lipo -archs ${f}`.nothrow().quiet()).text().trim()
        if (archs === "arm64") continue
        if (!archs.split(/\s+/).includes("arm64")) fail(`lxml/${rel} has no arm64 slice (${archs})`)
        const mode = (await fs.stat(f)).mode & 0o777
        const r = await $`/usr/bin/lipo ${f} -thin arm64 -output ${f}.thin`.nothrow().quiet()
        if (r.exitCode !== 0) fail(`lipo lxml/${rel} exit ${r.exitCode}`)
        await fs.rename(`${f}.thin`, f)
        await fs.chmod(f, mode)
        if ((await $`/usr/bin/lipo -archs ${f}`.nothrow().quiet()).text().trim() !== "arm64") fail(`lxml/${rel} not arm64 after thin`)
        thinned.push(`${SITE}/lxml/${rel}`)
      }

      // 7b. Sign every Mach-O regular file (row 52a), deepest first as osx-sign does, then verify each strictly. codesign
      //     stores the entitlements only in the one executable (python3.14); for a .so/.dylib it keeps none, as for
      //     Electron's own libraries, and python's disable-library-validation is what lets it load them.
      const signed: string[] = []
      for (const rel of await walk(rt)) {
        const st = await fs.lstat(path.join(rt, rel))
        if (st.isFile() && (await isMachO(path.join(rt, rel)))) signed.push(rel)
      }
      signed.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))
      for (const rel of signed) {
        const f = path.join(rt, rel)
        const r = await $`/usr/bin/codesign ${codesignArgs(f)}`.nothrow().quiet()
        if (r.exitCode !== 0) fail(`codesign ${rel} exit ${r.exitCode}: ${r.stderr.toString().trim()}`)
        const v = await $`/usr/bin/codesign --verify --strict ${f}`.nothrow().quiet()
        if (v.exitCode !== 0) fail(`codesign --verify ${rel} exit ${v.exitCode}: ${v.stderr.toString().trim()}`)
      }
      console.log(`DATUM_RUNTIME_STAGE signed ${signed.length} Mach-O (ad hoc, runtime, ${path.relative(DESKTOP, ENTITLEMENTS)})`)
    }

    // 8. Launcher, render shim, .pth.
    await fs.mkdir(path.join(rt, "bin"), { recursive: true })
    await fs.writeFile(path.join(rt, "bin", "datum-python"), LAUNCHER, { mode: 0o755 })
    await fs.copyFile(path.join(SHIM, "bin", "rsvg-convert"), path.join(rt, "bin", "rsvg-convert"))
    for (const n of ["datum-python", "rsvg-convert"]) await fs.chmod(path.join(rt, "bin", n), 0o755)
    await fs.writeFile(path.join(site, PTH.name), `${PTH.line}\n`, { mode: 0o644 })

    // 9. Smoke test from cwd / with the skill linked where Resources keeps it. Nothing may be written into the stage.
    await fs.symlink(SKILL, path.join(res, "datum-house-style"))
    if (linux) {
      // Row 122: static smoke (the linux python cannot run here; the import run is LP-23 in colima). Every module of the
      // darwin smoke that this stage installs must resolve as a file, through the .pth for the skill scripts, and the
      // excluded ones must be absent.
      const pthDir = path.resolve(site, (await fs.readFile(path.join(site, PTH.name), "utf8")).trim())
      const missing: string[] = []
      for (const m of LINUX_SITE_IMPORTS) if (!(await moduleFile(site, m))) missing.push(m)
      for (const m of LINUX_SKILL_IMPORTS) if (!(await moduleFile(pthDir, m))) missing.push(m)
      if (missing.length) fail(`static smoke: not found ${missing.join(", ")}`)
      const stdlib = path.join(rt, "python", PY_LIB)
      const present: string[] = []
      for (const m of ["matplotlib", "fitz", "pip", "tkinter", "cairosvg"])
        for (const root of [site, stdlib, path.join(stdlib, "lib-dynload")]) if (await moduleFile(root, m)) present.push(m)
      if (await moduleFile(path.join(stdlib, "lib-dynload"), "_tkinter")) present.push("_tkinter")
      if (present.length) fail(`static smoke: present ${present.join(", ")}`)
      if ((await fs.readFile(path.join(rt, "bin", "datum-python"), "utf8")) !== LAUNCHER) fail("bin/datum-python is not LAUNCHER")
      if ((await sha256File(path.join(rt, "bin", "rsvg-convert"))) !== (await sha256File(path.join(SHIM, "bin", "rsvg-convert"))))
        fail("bin/rsvg-convert is not the shim")
      console.log(
        `DATUM_RUNTIME_STAGE static smoke ok ${PYTHON_LINUX.version} (${LINUX_SITE_IMPORTS.length} site + ${LINUX_SKILL_IMPORTS.length} skill modules resolve; import run = LP-23 in colima)`,
      )
    } else {
      const marker = path.join(work, "marker")
      await fs.writeFile(marker, "")
      await Bun.sleep(1100) // mtime granularity guard for the -newer check
      const smoke = [
        "import importlib.util, sys",
        "import docx, openpyxl, pptx, lxml, lxml.etree, PIL, PIL.Image, PIL._imaging, PIL._imagingft, xlsxwriter, et_xmlfile, typing_extensions",
        "import datumbind, datumcheck, embed_fonts, datum_symbols, datumchart, playwright.sync_api, datum_render_shim, sqlite3, ssl, zlib",
        "absent = [m for m in ('matplotlib', 'fitz', 'pip', 'tkinter', 'cairosvg') if importlib.util.find_spec(m)]",
        "assert not absent, absent",
        "f = sys.flags; assert f.isolated and f.dont_write_bytecode and f.no_user_site and f.safe_path",
        "print('smoke ok', sys.version.split()[0], PIL.__version__, lxml.etree.LXML_VERSION)",
      ].join("\n")
      const s = await $`${path.join(rt, "bin", "datum-python")} -c ${smoke}`.env(env).cwd("/").nothrow().quiet()
      if (s.exitCode !== 0) fail(`smoke exit ${s.exitCode}: ${s.stderr.toString().trim().split("\n").slice(-2).join(" | ")}`)
      console.log(`DATUM_RUNTIME_STAGE ${s.stdout.toString().trim()}`)
      const v = await $`${path.join(rt, "bin", "rsvg-convert")} -v`.env(env).cwd("/").nothrow().quiet()
      if (v.exitCode !== 0 || !v.stdout.toString().includes("datum-render-shim")) fail("bin/rsvg-convert -v is not the shim")
      const newer = (await $`/usr/bin/find ${rt} -newer ${marker}`.nothrow().quiet()).text().trim()
      if (newer) fail(`smoke wrote into the stage: ${newer.split("\n").slice(0, 3).join(", ")}`)
    }
    await fs.rm(path.join(res, "datum-house-style"))

    // 10. Inventory: no .pyc, exactly 35 Mach-O, then the manifest (no timestamps: equal inputs give an equal manifest).
    const files: Array<{ path: string; kind: "macho" | "elf" | "data" | "symlink"; mode: string; size?: number; sha256?: string; target?: string }> = []
    let bytes = 0
    for (const rel of await walk(rt)) {
      const abs = path.join(rt, rel)
      const st = await fs.lstat(abs)
      if (rel.endsWith(".pyc") || path.basename(rel) === "__pycache__") fail(`bytecode left: ${rel}`)
      if (st.isDirectory()) continue
      const mode = (st.mode & 0o777).toString(8)
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(abs)
        if (path.isAbsolute(target) || !path.resolve(path.dirname(abs), target).startsWith(rt + path.sep)) fail(`symlink leaves the stage: ${rel}`)
        files.push({ path: rel, kind: "symlink", mode, target })
        continue
      }
      if (!st.isFile()) fail(`not a regular file: ${rel}`)
      bytes += st.size
      if (linux) {
        // Row 122: ELF x86-64 is the only native kind; a Mach-O or PE file, or a non-x86-64 ELF, stops the stage.
        const native = await nativeKind(abs)
        if (native && native.kind !== "elf") fail(`${native.kind} file in the linux-x64 stage: ${rel}`)
        if (native && !native.x64) fail(`ELF ${rel} is not x86-64`)
        files.push({ path: rel, kind: native ? "elf" : "data", mode, size: st.size, sha256: await sha256File(abs) })
        continue
      }
      files.push({ path: rel, kind: (await isMachO(abs)) ? "macho" : "data", mode, size: st.size, sha256: await sha256File(abs) })
    }
    if (linux) return await finishLinux(args, rt, files, bytes, pruned)
    const macho = files.filter((f) => f.kind === "macho")
    if (macho.length !== MACHO_EXPECTED) fail(`${macho.length} Mach-O files, expected ${MACHO_EXPECTED}`)
    for (const f of macho)
      if ((await $`/usr/bin/lipo -archs ${path.join(rt, f.path)}`.nothrow().quiet()).text().trim() !== "arm64") fail(`${f.path} is not arm64-only`)

    const manifest = {
      schema: 1,
      name: "datum-runtime",
      version: RELEASE,
      python: { version: PYTHON.version, release: PYTHON.release, asset: PYTHON.file, sha256: PYTHON.sha256 },
      wheels: [...WHEELS.map(({ name, version, file, sha256 }) => ({ name, version, file, sha256 })), { ...SHIM_WHEEL }],
      launcher: "bin/datum-python",
      pth: { path: `${SITE}/${PTH.name}`, line: PTH.line },
      skillSha: await sha256File(path.join(SKILL, "SKILL.md")),
      // Row 52a: Mach-O sizes and sha256 below are the signed bytes that ship (electron-builder skips this folder).
      signing: { identity: "-", options: "runtime", entitlementsSha256: await sha256File(ENTITLEMENTS) },
      pruned,
      thinned,
      counts: { files: files.filter((f) => f.kind !== "symlink").length, macho: macho.length, symlinks: files.filter((f) => f.kind === "symlink").length, bytes },
      files,
    }
    const manifestText = `${JSON.stringify(manifest, null, 1)}\n`
    await fs.writeFile(path.join(rt, "runtime-manifest.json"), manifestText, { mode: 0o644 })

    // 11. Replace the output only now.
    await fs.rm(args.out, { recursive: true, force: true })
    await fs.rename(rt, args.out)
    const msha = createHash("sha256").update(manifestText).digest("hex")
    console.log(`DATUM_RUNTIME_STAGE files=${manifest.counts.files} macho=${macho.length} symlinks=${manifest.counts.symlinks} bytes=${bytes} thinned=${thinned.length} pyc=0`)
    console.log(`DATUM_RUNTIME_STAGE manifest sha256 ${msha}`)
    console.log(`DATUM_RUNTIME_STAGE_OK ${args.out}`)
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof StageFail)) throw error
    console.error(`DATUM_RUNTIME_STAGE_FAIL ${error.message}`)
    process.exit(1)
  }
}
