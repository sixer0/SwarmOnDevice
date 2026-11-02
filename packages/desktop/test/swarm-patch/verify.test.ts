// Row 16: `verify` rejection matrix (spec 9.5 V-01..V-22) plus the RK cases of row 16 (V-11 sig bound, V-27,
// V-28 dash/relative/hidden, zipinfo summary) and the D39-2 symlink layers. Synthetic keys only ($T/keys).
// Every rejection also checks INV-1..4 (spec 9.2). verify never calls pgrep, so all cases run in the sandbox.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedSigners,
  applier,
  buildApp,
  CONTAINER_ENTRIES,
  createEnv,
  type Env,
  expectReject,
  installApp,
  invariants,
  must,
  NAMESPACE,
  type Package,
  PATCH_FOLDER,
  pkg,
  REPO_APPLIER,
  run,
  snapshot,
} from "./fixture"

setDefaultTimeout(180_000)

const V01_STDOUT = "result=verified\nrelease=1.2.0\nfrom_release=1.1.0\nmigration=none\nnew_key=no\n"

let env: Env
let installed: string
let next: string
let base: Package
let n = 0

const fresh = async (name = "p.swarmpatch") => {
  const dir = path.join(env.root, "case", String(++n))
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, name)
}
const signersOf = (app: string) => path.join(app, "Contents", "Resources", PATCH_FOLDER, "allowed_signers")

/** Copies the three entries of a package into a new folder for editing; returns that folder. */
async function entries(p: Package) {
  const dir = path.dirname(await fresh())
  for (const e of CONTAINER_ENTRIES) await fs.copyFile(path.join(p.work, e), path.join(dir, e))
  return dir
}

/** `zip -q -X -j -0 <out> <names>` from `dir` (spec 3.1 builder), with optional extra flags. */
async function zipFrom(dir: string, names: string[], flags: string[] = [], name = "p.swarmpatch") {
  const out = path.join(dir, "out", name)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await must(["/usr/bin/zip", "-q", "-X", "-j", "-0", ...flags, out, ...names], { cwd: dir })
  return out
}

async function signIn(dir: string, namespace = NAMESPACE, key = env.keys.k) {
  await fs.rm(path.join(dir, "manifest.sig"), { force: true })
  await must(["/usr/bin/ssh-keygen", "-Y", "sign", "-f", key, "-n", namespace, "manifest"], { cwd: dir })
}

/** Replaces every occurrence of an equal-length byte string in a file. */
async function patchBytes(file: string, from: string, to: string) {
  if (from.length !== to.length) throw new Error("patchBytes needs equal lengths")
  const buf = Buffer.from(await fs.readFile(file))
  const f = Buffer.from(from, "latin1")
  let hits = 0
  for (let i = buf.indexOf(f); i !== -1; i = buf.indexOf(f, i + 1)) {
    buf.write(to, i, "latin1")
    hits++
  }
  if (hits === 0) throw new Error(`patchBytes: ${from} not found in ${file}`)
  await fs.writeFile(file, buf)
}

/** Builds a package whose payload.zip is made by `zip -r -y` from `top` (several entries allowed). */
async function customPayload(top: string, names: string[]) {
  await must(["/usr/bin/zip", "-q", "-r", "-y", "-X", path.join(top, "payload.zip"), ...names], { cwd: top })
  const pz = path.join(top, "payload.zip")
  const sha = (await must(["/usr/bin/shasum", "-a", "256", pz])).stdout.slice(0, 64)
  const bytes = (await must(["/usr/bin/stat", "-f", "%z", pz])).stdout.trim()
  const manifest = base.manifest
    .replace(/payload_sha256=\w+/, `payload_sha256=${sha}`)
    .replace(/payload_bytes=\d+/, `payload_bytes=${bytes}`)
  await fs.writeFile(path.join(top, "manifest"), manifest)
  await signIn(top)
  return zipFrom(top, [...CONTAINER_ENTRIES])
}

async function expectVerified(args: string[], o: { app?: string; cwd?: string; env?: Record<string, string> } = {}) {
  const target = o.app ?? installed
  const before = await snapshot(env, target)
  const r = await applier(env, args, target, o)
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
  expect(await invariants(env, before, target)).toEqual([])
  return r
}

/** A copy of the repo applier with exact source text removed or replaced; refuses if a line is not found (mutation guard). */
async function mutatedApplier(name: string, edits: (string | [string, string])[]) {
  let text = await fs.readFile(REPO_APPLIER, "utf8")
  for (const edit of edits) {
    const [from, to] = typeof edit === "string" ? [edit, ""] : edit
    if (!text.includes(from)) throw new Error(`mutation anchor not found: ${from}`)
    text = text.replaceAll(from, to)
  }
  const file = path.join(env.root, "mut", name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, { mode: 0o755 })
  return buildApp(env, { release: "1.1.0", applier: file, into: path.join(env.root, "inst", name) })
}

beforeAll(async () => {
  env = await createEnv()
  installed = await installApp(env)
  next = await buildApp(env, { release: "1.2.0" })
  base = await pkg(env, next)
})
afterAll(async () => env?.cleanup())

describe("V-01 and accepted variants", () => {
  test("V-01 valid 1.1.0 -> 1.2.0 none: exit 0, exact stdout, INV-1..4", async () => {
    const r = await expectVerified(["verify", base.path])
    expect(r.stdout).toBe(V01_STDOUT)
  })

  test("V-27 UNZIP/UNZIPOPT/LC_ALL/PATH set by caller: same result as V-01", async () => {
    const r = await expectVerified(["verify", base.path], {
      env: {
        HOME: env.home,
        UNZIP: "-x",
        UNZIPOPT: "-a",
        ZIPOPT: "-0",
        LC_ALL: "tr_TR.UTF-8",
        LC_CTYPE: "tr_TR.UTF-8",
        PATH: "/nonexistent",
      },
    })
    expect(r.stdout).toBe(V01_STDOUT)
  })

  test("V-28 relative argument is resolved to an absolute path (accepted)", async () => {
    const cwd = path.dirname(base.path)
    for (const arg of [path.basename(base.path), `./${path.basename(base.path)}`]) {
      const r = await expectVerified(["verify", arg], { cwd })
      expect(r.stdout).toBe(V01_STDOUT)
    }
  })

  test("new_key=yes when the new app carries another allowed_signers", async () => {
    const nk = await buildApp(env, { release: "1.2.0", signerPub: `${env.keys.other}.pub` })
    const r = await expectVerified(["verify", (await pkg(env, nk, { signers: signersOf(installed) })).path])
    expect(r.stdout).toContain("new_key=yes\n")
  })

  test("G1c: CFBundleShortVersionString 1.19.3 differs from release and is accepted", async () => {
    const plist = (
      await must([
        "/usr/bin/plutil",
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        path.join(next, "Contents/Info.plist"),
      ])
    ).stdout.trim()
    expect(plist).toBe("1.19.3")
  })
})

describe("signature (V-02..V-06)", () => {
  test("V-02 signed with key other", async () => {
    const s = path.join(env.root, "other_signers")
    await fs.writeFile(s, await allowedSigners(`${env.keys.other}.pub`))
    await expectReject(env, ["verify", (await pkg(env, next, { key: env.keys.other, signers: s })).path], "E_SIGNATURE")
  })

  test("V-03 signed with another namespace", async () => {
    const d = await entries(base)
    await signIn(d, "id.co.gsp.swarm.patch.v2")
    await expectReject(env, ["verify", await zipFrom(d, [...CONTAINER_ENTRIES])], "E_SIGNATURE")
  })

  test("V-04 manifest changed by one byte after signing (still a valid manifest)", async () => {
    const d = await entries(base)
    await patchBytes(path.join(d, "manifest"), "from_min=1.0.0", "from_min=1.0.1")
    await expectReject(env, ["verify", await zipFrom(d, [...CONTAINER_ENTRIES])], "E_SIGNATURE")
  })

  test("V-05 manifest.sig truncated, and empty", async () => {
    for (const cut of [(s: Buffer) => s.subarray(0, Math.floor(s.length / 2)), () => Buffer.alloc(0)]) {
      const d = await entries(base)
      const sig = path.join(d, "manifest.sig")
      await fs.writeFile(sig, cut(Buffer.from(await fs.readFile(sig))))
      await expectReject(env, ["verify", await zipFrom(d, [...CONTAINER_ENTRIES])], "E_SIGNATURE")
    }
  })

  test("V-06 installed fixture with empty allowed_signers (re-signed ad hoc)", async () => {
    const app = await buildApp(env, {
      release: "1.1.0",
      into: path.join(env.root, "inst", "empty_signers"),
      mutate: async (a) => fs.writeFile(signersOf(a), ""),
    })
    await expectReject(env, ["verify", base.path], "E_SIGNATURE", { app })
  })
})

describe("container (V-07..V-10, RK-20)", () => {
  test("V-07 two entries, four entries, foreign name, duplicate name", async () => {
    const d = await entries(base)
    await expectReject(env, ["verify", await zipFrom(d, ["manifest", "payload.zip"], [], "two.swarmpatch")], "E_CONTAINER")
    await fs.writeFile(path.join(d, "extra"), "x")
    await expectReject(
      env,
      ["verify", await zipFrom(d, [...CONTAINER_ENTRIES, "extra"], [], "four.swarmpatch")],
      "E_CONTAINER",
    )
    await fs.copyFile(path.join(d, "manifest.sig"), path.join(d, "foreign"))
    await expectReject(
      env,
      ["verify", await zipFrom(d, ["manifest", "foreign", "payload.zip"], [], "foreign.swarmpatch")],
      "E_CONTAINER",
    )
    // Duplicate: an 8-character name rewritten to `manifest` in both headers.
    await fs.writeFile(path.join(d, "manifesu"), "format=1\n")
    const dup = await zipFrom(d, ["manifest", "manifesu", "payload.zip"], [], "dup.swarmpatch")
    await patchBytes(dup, "manifesu", "manifest")
    expect((await run(["/usr/bin/zipinfo", "-1", dup])).stdout).toBe("manifest\nmanifest\npayload.zip\n")
    await expectReject(env, ["verify", dup], "E_CONTAINER")
  })

  test("V-08 symlink entry (zip -y)", async () => {
    const d = await entries(base)
    await fs.rename(path.join(d, "manifest.sig"), path.join(d, "sig.real"))
    await fs.symlink("sig.real", path.join(d, "manifest.sig"))
    const p = await zipFrom(d, [...CONTAINER_ENTRIES], ["-y"])
    expect((await run(["/usr/bin/zipinfo", p])).stdout).toMatch(/^l/m)
    await expectReject(env, ["verify", p], "E_CONTAINER")
  })

  test("V-09 entry named ../manifest", async () => {
    const d = await entries(base)
    await fs.copyFile(path.join(d, "manifest"), path.join(d, "aaamanifest"))
    const p = await zipFrom(d, ["aaamanifest", "manifest.sig", "payload.zip"])
    await patchBytes(p, "aaamanifest", "../manifest")
    expect((await run(["/usr/bin/zipinfo", "-1", p])).stdout).toContain("../manifest\n")
    await expectReject(env, ["verify", p], "E_CONTAINER")
  })

  test("V-10 not a zip, with the .swarmpatch suffix", async () => {
    const p = await fresh()
    await fs.writeFile(p, "not a zip\n")
    await expectReject(env, ["verify", p], "E_CONTAINER")
  })

  test("RK-20 zipinfo summary does not report 3 entries (EOCD count rewritten)", async () => {
    for (const count of [2, 4]) {
      const d = await entries(base)
      const p = await zipFrom(d, [...CONTAINER_ENTRIES], [], `eocd${count}.swarmpatch`)
      const buf = Buffer.from(await fs.readFile(p))
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
      expect(eocd).toBeGreaterThan(0)
      buf.writeUInt16LE(count, eocd + 8)
      buf.writeUInt16LE(count, eocd + 10)
      await fs.writeFile(p, buf)
      await expectReject(env, ["verify", p], "E_CONTAINER")
    }
  })

  // The real zipinfo already exits 3 on a wrong EOCD count, so the listing/summary checks are tested on an
  // applier copy that ignores the zipinfo exit status; a second copy without those checks shows what they catch.
  test("RK-20 listing/summary layer apart from the zipinfo exit status", async () => {
    const STATUS: [string, string] = [
      ' || sp_die E_CONTAINER "the patch file is not a valid zip container"',
      " || true",
    ]
    const SUMMARY = [
      '  (( ${#lines} == 6 )) || sp_die E_CONTAINER "unexpected zipinfo listing"\n',
      "  [[ $lines[2] =~ ', number of entries: ([0-9]{1,6})$' && $match[1] == 3 ]] \\\n" +
        '    || sp_die E_CONTAINER "the container summary does not report exactly 3 entries"\n',
      "  [[ $lines[6] == '3 files, '* ]] || sp_die E_CONTAINER \"unexpected zipinfo summary\"\n",
    ]
    const d = await entries(base)
    const p = await zipFrom(d, [...CONTAINER_ENTRIES], [], "eocd.swarmpatch")
    const buf = Buffer.from(await fs.readFile(p))
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    buf.writeUInt16LE(4, eocd + 8)
    buf.writeUInt16LE(4, eocd + 10)
    await fs.writeFile(p, buf)
    const layer = await mutatedApplier("no_zipinfo_status", [STATUS])
    const r = await expectReject(env, ["verify", p], "E_CONTAINER", { app: layer })
    expect(r.stderr).toMatch(/unexpected zipinfo listing|does not report exactly 3 entries|unexpected zipinfo summary/)
    const bare = await mutatedApplier("no_zipinfo_status_no_summary", [STATUS, ...SUMMARY])
    const before = await snapshot(env, bare)
    const r2 = await applier(env, ["verify", p], bare)
    expect(r2.stderr).not.toMatch(
      /unexpected zipinfo listing|does not report exactly 3 entries|unexpected zipinfo summary/,
    )
    expect(await invariants(env, before, bare)).toEqual([])
  })
})

describe("manifest (V-11, V-12, V-15b, V-16)", () => {
  test("V-11 manifest over 16384 B (signed), and manifest.sig over 4096 B", async () => {
    const big = await pkg(env, next, { editManifest: (t) => t + `zz=${"a".repeat(16400)}\n` })
    await expectReject(env, ["verify", big.path], "E_MANIFEST")
    const d = await entries(base)
    const sig = await fs.readFile(path.join(d, "manifest.sig"), "utf8")
    await fs.writeFile(path.join(d, "manifest.sig"), sig + "A".repeat(4097 - sig.length + 10))
    await expectReject(env, ["verify", await zipFrom(d, [...CONTAINER_ENTRIES])], "E_MANIFEST")
  })

  const variants: [string, (t: string) => string][] = [
    ["unknown key", (t) => t + "extra_key=1\n"],
    ["duplicate key", (t) => t + "format=1\n"],
    ["missing key", (t) => t.replace("format=1\n", "")],
    ["CRLF", (t) => t.replaceAll("\n", "\r\n")],
    ["format=2", (t) => t.replace("format=1", "format=2")],
    ["other bundle_id", (t) => t.replace("bundle_id=id.co.gsp.swarm.desktop", "bundle_id=id.co.gsp.swarm.other")],
    ["V-15 release=1.2.0-rc1", (t) => t.replace("release=1.2.0", "release=1.2.0-rc1")],
    ["V-16 migration=other", (t) => t.replace("migration=none", "migration=other")],
    [
      "V-16 none with data_min_release > from_min",
      (t) => t.replace("data_min_release=1.0.0", "data_min_release=1.1.0"),
    ],
    ["V-16 forward with data_min_release != release", (t) => t.replace("migration=none", "migration=forward")],
  ]
  for (const [name, edit] of variants)
    test(`V-12 ${name}`, async () => {
      await expectReject(env, ["verify", (await pkg(env, next, { editManifest: edit })).path], "E_MANIFEST")
    })
})

describe("release order (V-13..V-15)", () => {
  test("V-13 release equals the installed release", async () => {
    const same = await buildApp(env, { release: "1.1.0" })
    await expectReject(env, ["verify", (await pkg(env, same)).path], "E_DOWNGRADE")
  })

  test("V-14 release below the installed release", async () => {
    const older = await buildApp(env, { release: "1.0.5" })
    await expectReject(env, ["verify", (await pkg(env, older)).path], "E_DOWNGRADE")
  })

  test("V-15 installed release below from_min", async () => {
    await expectReject(env, ["verify", (await pkg(env, next, { fromMin: "1.1.1" })).path], "E_DOWNGRADE")
  })
})

describe("payload (V-17, V-18)", () => {
  test("V-17 payload.zip swapped, manifest unchanged", async () => {
    const other = await pkg(
      env,
      await buildApp(env, {
        release: "1.2.0",
        mutate: (a) => fs.writeFile(path.join(a, "Contents/Resources/data.txt"), "other\n"),
      }),
    )
    const d = await entries(base)
    await fs.copyFile(path.join(other.work, "payload.zip"), path.join(d, "payload.zip"))
    await expectReject(env, ["verify", await zipFrom(d, [...CONTAINER_ENTRIES])], "E_HASH")
  })

  test("V-18 payload_bytes too small and too large", async () => {
    for (const delta of [-1, 1]) {
      const p = await pkg(env, next, {
        editManifest: (t) => t.replace(/payload_bytes=(\d+)/, (_, b) => `payload_bytes=${Number(b) + delta}`),
      })
      await expectReject(env, ["verify", p.path], "E_HASH")
    }
  })
})

describe("new app (V-19, RK-16) and own bundle (V-20)", () => {
  test("V-19 new app changed by one byte after codesign", async () => {
    const app = await buildApp(env, { release: "1.2.0" })
    await patchBytes(path.join(app, "Contents/Resources/data.txt"), "synthetic", "Synthetic")
    await expectReject(env, ["verify", (await pkg(env, app)).path], "E_SEAL", { message: "codesign" })
  })

  test("V-19 SwarmRelease of the new app differs from release", async () => {
    await expectReject(
      env,
      ["verify", (await pkg(env, next, { editManifest: (t) => t.replace("release=1.2.0", "release=1.3.0") })).path],
      "E_SEAL",
    )
  })

  test("V-19 other CFBundleIdentifier", async () => {
    const app = await buildApp(env, { release: "1.2.0", info: { CFBundleIdentifier: "id.co.gsp.swarm.other" } })
    await expectReject(env, ["verify", (await pkg(env, app)).path], "E_SEAL")
  })

  test("V-19 absolute symlink, and symlink leaving the bundle", async () => {
    const abs = await buildApp(env, {
      release: "1.2.0",
      mutate: (a) => fs.symlink("/etc/hosts", path.join(a, "Contents/Resources/abs")),
    })
    await expectReject(env, ["verify", (await pkg(env, abs)).path], "E_SEAL")
    const esc = await buildApp(env, {
      release: "1.2.0",
      mutate: (a) => fs.symlink("../../..", path.join(a, "Contents/Resources/esc")),
    })
    await expectReject(env, ["verify", (await pkg(env, esc)).path], "E_SEAL")
  })

  test("V-19 applier missing, and allowed_signers missing", async () => {
    for (const file of ["swarm-patch", "allowed_signers"]) {
      const app = await buildApp(env, {
        release: "1.2.0",
        mutate: (a) => fs.rm(path.join(a, "Contents/Resources", PATCH_FOLDER, file)),
      })
      await expectReject(env, ["verify", (await pkg(env, app, { signers: signersOf(next) })).path], "E_SEAL")
    }
  })

  test("V-19 payload.zip with two top entries", async () => {
    const top = path.dirname(await fresh())
    await must(["/usr/bin/ditto", next, path.join(top, "Swarm.app")])
    await fs.mkdir(path.join(top, "Other"))
    await fs.writeFile(path.join(top, "Other", "f"), "x")
    await expectReject(env, ["verify", await customPayload(top, ["Swarm.app", "Other"])], "E_SEAL")
  })

  test("V-28/RK-16 hidden file beside Swarm.app at the payload top", async () => {
    const top = path.dirname(await fresh())
    await must(["/usr/bin/ditto", next, path.join(top, "Swarm.app")])
    await fs.writeFile(path.join(top, ".hidden"), "x")
    await expectReject(env, ["verify", await customPayload(top, ["Swarm.app", ".hidden"])], "E_SEAL")
  })

  test("V-20 installed bundle changed by one byte after codesign", async () => {
    const app = await buildApp(env, { release: "1.1.0", into: path.join(env.root, "inst", "tampered") })
    await patchBytes(path.join(app, "Contents/Resources/data.txt"), "synthetic", "Synthetic")
    await expectReject(env, ["verify", base.path], "E_SEAL", { app })
  })
})

// D39-2: the symlink checks of V14 (e) are tested apart from codesign. The installed applier is a copy with the
// new-app codesign call removed, so only the symlink layer can reject. A control with both removed shows the
// link would otherwise pass.
describe("D39-2 symlink layers without codesign", () => {
  const CODESIGN =
    '/usr/bin/codesign --verify --deep --strict -- "$app" >/dev/null 2>&1 || sp_die E_SEAL "new app fails codesign verification"'
  const REAL = '[[ ${l:A} == $app/* ]] || sp_die E_SEAL "new app holds a symlink that resolves outside the bundle"'
  const LEX = '[[ $lex == $app/* ]] || sp_die E_SEAL "new app holds a symlink that leaves the bundle"'
  // Resources/b -> .. (lexically and really Contents); Resources/a -> b/../.. is lexically Contents but really x/.
  const realEscape = async (a: string) => {
    await fs.symlink("..", path.join(a, "Contents/Resources/b"))
    await fs.symlink("b/../..", path.join(a, "Contents/Resources/a"))
  }
  const lexEscape = (a: string) => fs.symlink("../../..", path.join(a, "Contents/Resources/esc"))

  test("real-path layer (:A) rejects a link that is lexically inside", async () => {
    const app = await mutatedApplier("no_codesign", [CODESIGN])
    const p = await pkg(env, await buildApp(env, { release: "1.2.0", mutate: realEscape }))
    await expectReject(env, ["verify", p.path], "E_SEAL", { app, message: "resolves outside the bundle" })
  })

  test("control: without codesign and without :A the same package verifies", async () => {
    const app = await mutatedApplier("no_codesign_no_real", [CODESIGN, REAL])
    const p = await pkg(env, await buildApp(env, { release: "1.2.0", mutate: realEscape }))
    const r = await expectVerified(["verify", p.path], { app })
    expect(r.stdout).toContain("result=verified\n")
  })

  test("lexical layer (:a) rejects a link that leaves the bundle", async () => {
    const app = await mutatedApplier("no_codesign_no_real_lex", [CODESIGN, REAL])
    const p = await pkg(env, await buildApp(env, { release: "1.2.0", mutate: lexEscape }))
    await expectReject(env, ["verify", p.path], "E_SEAL", { app, message: "leaves the bundle" })
  })

  test("control: without codesign, :A and :a the leaving link verifies", async () => {
    const app = await mutatedApplier("none", [CODESIGN, REAL, LEX])
    const p = await pkg(env, await buildApp(env, { release: "1.2.0", mutate: lexEscape }))
    await expectVerified(["verify", p.path], { app })
  })
})

describe("usage (V-21, V-22, V-28 dash)", () => {
  test("V-21 no argument, extra argument, .zip suffix, unknown subcommand, --accept-new-key on verify", async () => {
    await expectReject(env, ["verify"], "E_USAGE")
    await expectReject(env, ["verify", base.path, base.path], "E_USAGE")
    const zip = path.join(path.dirname(await fresh()), "p.zip")
    await fs.copyFile(base.path, zip)
    await expectReject(env, ["verify", zip], "E_USAGE")
    await expectReject(env, ["frobnicate", base.path], "E_USAGE")
    await expectReject(env, ["verify", "--accept-new-key", base.path], "E_USAGE")
  })

  test("V-22 patch file is a symlink", async () => {
    const ln = path.join(path.dirname(await fresh()), "l.swarmpatch")
    await fs.symlink(base.path, ln)
    await expectReject(env, ["verify", ln], "E_USAGE")
  })

  test("V-28 names starting with -: relative argument and absolute basename", async () => {
    const dir = path.dirname(await fresh())
    await fs.copyFile(base.path, path.join(dir, "-x.swarmpatch"))
    await expectReject(env, ["verify", "-x.swarmpatch"], "E_USAGE", { cwd: dir })
    await expectReject(env, ["verify", path.join(dir, "-x.swarmpatch")], "E_USAGE")
  })
})
