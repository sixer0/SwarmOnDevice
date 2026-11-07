#!/usr/bin/env bun
// Stages Resources/datum-runtime for DATUM's Python scripts (1.2.0 row 23; runtime spec §1-2, packaging spec §2.4 and §3).
// Built from the pinned python-build-standalone tarball and hash-pinned wheels, cached in tools/build/datum_runtime_cache
// so a second run needs no network. Adds the datum-render-shim wheel (row 106), bin/datum-python (-I -B), bin/rsvg-convert,
// the datum-house-style.pth, prunes (spec §1.3 + packaging §2.4 rule 4 + probe F4/F5), thins lxml to arm64 and writes
// runtime-manifest.json. Never writes .pyc: every staged-python call runs -I -B (probe F1). Signs nothing (packaging §2.4
// rule 1: electron-builder signs Resources inside-out). The stage folder is replaced only when every check passes.
//
//   bun scripts/stage-datum-runtime.ts [--out DIR] [--cache DIR] [--offline]
import { $ } from "bun"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

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
export const MACHO_EXPECTED = 35 // research/09 §7, packaging §2.4 rule 3, recipe DATUM_MACHO
// After the prune only these stay in python/bin and python/lib (allow-list; everything else there is removed).
const KEEP_BIN = ["python", "python3", "python3.14"]
const KEEP_LIB = ["python3.14"]
// Removed inside python/ (spec §1.3 + packaging §2.4 rule 4 + F4 libpython + F5 pip + _tkinter).
const PRUNE_TOP = ["include", "share"]
const PRUNE_STDLIB = ["idlelib", "tkinter", "turtledemo", "ensurepip", "config-3.14-darwin", "test", "lib2to3"]

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

function lockText() {
  return [
    "# datum-runtime 1.2.0 lock (scripts/stage-datum-runtime.ts; row 15 pins, research/09 §2)",
    ...[...WHEELS].sort((a, b) => a.name.localeCompare(b.name)).map((w) => `${w.name}==${w.version} --hash=sha256:${w.sha256}`),
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (process.platform !== "darwin" || process.arch !== "arm64") fail(`host ${process.platform}/${process.arch}, need darwin/arm64`)
  for (const p of [path.join(SKILL, "SKILL.md"), path.join(SHIM, "build_wheel.py"), path.join(SHIM, "bin", "rsvg-convert")])
    if (!(await exists(p))) fail(`missing input ${path.relative(DESKTOP, p)}`)

  // 1. Inputs from the cache (fetch + verify if missing).
  const tarball = await cached(args.cache, PYTHON.file, PYTHON, args.offline)
  const wheelDir = path.join(args.cache, "wheels")
  let fetched = tarball.fetched ? 1 : 0
  for (const w of WHEELS) if ((await cached(args.cache, `wheels/${w.file}`, w, args.offline)).fetched) fetched++
  const lockPath = path.join(args.cache, "requirements.lock")
  const lock = lockText()
  if (!(await exists(lockPath))) await fs.writeFile(lockPath, lock)
  else if ((await fs.readFile(lockPath, "utf8")) !== lock) fail("cache requirements.lock differs from the pins in this script")
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
    const ver = (await $`${py} -I -B -c ${"import sys;print('%d.%d.%d' % sys.version_info[:3])"}`.env(env).cwd("/").nothrow().quiet()).text().trim()
    if (ver !== PYTHON.version) fail(`staged python reports ${ver}`)

    // 4. Shim wheel (row 106), built by the staged interpreter, gated by its pinned sha256.
    const shimDir = path.join(work, "shim")
    const b = await $`${py} -I -B ${path.join(SHIM, "build_wheel.py")} --out ${shimDir}`.env(env).cwd("/").nothrow().quiet()
    if (b.exitCode !== 0) fail(`build_wheel exit ${b.exitCode}: ${b.stderr.toString().trim()}`)
    const shimSha = await sha256File(path.join(shimDir, SHIM_WHEEL.file)).catch(() => "missing")
    if (shimSha !== SHIM_WHEEL.sha256) fail(`shim wheel sha256 ${shimSha} differs from the row 106 pin`)

    // 5. Install all nine wheels offline, hashes required, no compile, into the staged site-packages only.
    const runLock = path.join(work, "requirements.lock")
    await fs.writeFile(runLock, `${lock}${SHIM_WHEEL.name}==${SHIM_WHEEL.version} --hash=sha256:${SHIM_WHEEL.sha256}\n`)
    const site = path.join(rt, SITE)
    const pip =
      await $`${py} -I -B -m pip install --no-index --find-links ${wheelDir} --find-links ${shimDir} --no-deps --only-binary=:all: --require-hashes --no-compile --target ${site} -r ${runLock}`
        .env(env)
        .cwd("/")
        .nothrow()
        .quiet()
    if (pip.exitCode !== 0) fail(`pip exit ${pip.exitCode}: ${pip.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`)
    const installed = pip.stdout.toString().match(/Successfully installed (.*)/)?.[1]?.trim() ?? ""
    console.log(`DATUM_RUNTIME_STAGE pip ${installed}`)

    // 6. Prune (allow-list for python/bin and python/lib, deny-list inside the stdlib), then every .pyc/__pycache__.
    const pruned: string[] = []
    const remove = async (rel: string) => {
      await fs.rm(path.join(rt, rel), { recursive: true, force: true })
      pruned.push(rel)
    }
    for (const n of (await fs.readdir(path.join(rt, "python", "bin"))).sort()) if (!KEEP_BIN.includes(n)) await remove(`python/bin/${n}`)
    for (const n of (await fs.readdir(path.join(rt, "python", "lib"))).sort()) if (!KEEP_LIB.includes(n)) await remove(`python/lib/${n}`)
    for (const n of PRUNE_TOP) if (await exists(path.join(rt, "python", n))) await remove(`python/${n}`)
    for (const n of PRUNE_STDLIB) if (await exists(path.join(rt, "python", PY_LIB, n))) await remove(`python/${PY_LIB}/${n}`)
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

    // 8. Launcher, render shim, .pth.
    await fs.mkdir(path.join(rt, "bin"), { recursive: true })
    await fs.writeFile(path.join(rt, "bin", "datum-python"), LAUNCHER, { mode: 0o755 })
    await fs.copyFile(path.join(SHIM, "bin", "rsvg-convert"), path.join(rt, "bin", "rsvg-convert"))
    for (const n of ["datum-python", "rsvg-convert"]) await fs.chmod(path.join(rt, "bin", n), 0o755)
    await fs.writeFile(path.join(site, PTH.name), `${PTH.line}\n`, { mode: 0o644 })

    // 9. Smoke test from cwd / with the skill linked where Resources keeps it. Nothing may be written into the stage.
    await fs.symlink(SKILL, path.join(res, "datum-house-style"))
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
    await fs.rm(path.join(res, "datum-house-style"))

    // 10. Inventory: no .pyc, exactly 35 Mach-O, then the manifest (no timestamps: equal inputs give an equal manifest).
    const files: Array<{ path: string; kind: "macho" | "data" | "symlink"; mode: string; size?: number; sha256?: string; target?: string }> = []
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
      files.push({ path: rel, kind: (await isMachO(abs)) ? "macho" : "data", mode, size: st.size, sha256: await sha256File(abs) })
    }
    const macho = files.filter((f) => f.kind === "macho")
    if (macho.length !== MACHO_EXPECTED) fail(`${macho.length} Mach-O files, expected ${MACHO_EXPECTED}`)
    for (const f of macho)
      if ((await $`/usr/bin/lipo -archs ${path.join(rt, f.path)}`.nothrow().quiet()).text().trim() !== "arm64") fail(`${f.path} is not arm64-only`)

    const manifest = {
      schema: 1,
      name: "datum-runtime",
      version: "1.2.0",
      python: { version: PYTHON.version, release: PYTHON.release, asset: PYTHON.file, sha256: PYTHON.sha256 },
      wheels: [...WHEELS.map(({ name, version, file, sha256 }) => ({ name, version, file, sha256 })), { ...SHIM_WHEEL }],
      launcher: "bin/datum-python",
      pth: { path: `${SITE}/${PTH.name}`, line: PTH.line },
      skillSha: await sha256File(path.join(SKILL, "SKILL.md")),
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
