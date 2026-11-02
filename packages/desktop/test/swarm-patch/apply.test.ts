// Row 20: `apply` suite (spec 9.6 AP-01..AP-04, AP-06..AP-11), grown from the row 17 smoke checks.
// RK-09 holder `/bin/zsh -fc 'sleep 60; :' <path>`, RK-10 every process prefix of register 6 under the target and
// under `<state>/previous/Swarm.app`, a target with spaces and brackets, the applier not detecting itself,
// RK-17 (C5) backup kept after `forward`. Synthetic keys and fixture apps under $TMPDIR only.
// Every case builds its own Env and seeds the state it needs by real applies, so cases run alone (`-t`) or in any
// order (m10). Needs the process list: run outside the agent sandbox (protocol SB, H2). In the sandbox `pgrep`
// exits >= 2 and beforeAll fails every case with that reason; nothing is skipped.
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedSigners,
  applier,
  buildApp,
  cdhash,
  createEnv,
  type Env,
  expectReject,
  hasError,
  holder,
  installApp,
  invariants,
  journal,
  must,
  type PackageOptions,
  pkg,
  requireProcessList,
  run,
  snapshot,
  treeHash,
  verifySeal,
  withEnv,
  withHolder,
} from "./fixture"

setDefaultTimeout(180_000)

// Register 6, "Pola proses": the same three prefixes under the target and under the backup.
const PREFIXES = ["Contents/MacOS/Swarm", "Contents/Frameworks/x", "Contents/Resources/opencode-cli"]

const target = (e: Env) => path.join(e.apps, "Swarm.app")
const previous = (e: Env) => path.join(e.state, "previous", "Swarm.app")
const tooBig = (t: string) => t.replace(/^unpacked_bytes=.*$/m, "unpacked_bytes=999999999999")

/** Seeding step: builds `release` and applies it; any failure stops the case before its own assertions. */
async function applied(e: Env, release: string, o: Partial<PackageOptions> = {}, flags: string[] = []) {
  const p = await pkg(e, await buildApp(e, { release }), o)
  const r = await applier(e, ["apply", ...flags, p.path])
  expect({ seed: release, code: r.code, err: r.stderr.replace(/^swarm-patch: warning: .*\n/m, "") }).toEqual({
    seed: release,
    code: 0,
    err: "",
  })
}

beforeAll(() => requireProcessList("apply.test.ts"))

test("AP-06/AP-09 (RK-09, RK-10): every process prefix under the target and under previous/ gives E_RUNNING", () =>
  withEnv(async (e) => {
    await installApp(e)
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
    for (const w of [...PREFIXES.map((x) => `${target(e)}/${x}`), ...PREFIXES.map((x) => `${previous(e)}/${x}`)])
      await withHolder(w, async (pid) => {
        const r = await expectReject(e, ["apply", p.path], "E_RUNNING")
        expect(r.stderr).toContain(`pid ${pid}`)
      })
  }))

test("AP-01 valid none package applies; AP-11 verify and apply do not detect the applier or its ancestors", () =>
  withEnv(async (e) => {
    await installApp(e)
    const before = await treeHash(target(e))
    const oldCd = await cdhash(target(e))
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
    const script = path.join(target(e), "Contents", "Resources", "swarm-patch", "swarm-patch")
    // The applier runs from a zsh whose argv carries its own path, under a parent whose argv carries <target>/Contents/MacOS/.
    const viaParent = (sub: string) =>
      run(["/bin/zsh", "-fc", 'HOME=$4 /bin/zsh -f "$1" "$2" "$3"; :', `${target(e)}/Contents/MacOS/Swarm`, script, sub, p.path, e.home])
    const v = await viaParent("verify")
    expect({ code: v.code, err: v.stderr }).toEqual({ code: 0, err: "" })
    const r = await viaParent("apply")
    expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
    const lines = r.stdout.trim().split("\n")
    expect(lines[0]).toMatch(
      /^recover_command=\/bin\/zsh -f '.*\/previous\/Swarm\.app\/Contents\/Resources\/swarm-patch\/swarm-patch' recover --target '.*\/Swarm\.app'$/,
    )
    expect(lines.slice(1)).toEqual(["result=applied", "release=1.2.0", "from_release=1.1.0", "migration=none", "new_key=no"])
    expect((await verifySeal(target(e))).code).toBe(0)
    expect(
      (await must(["/usr/bin/plutil", "-extract", "SwarmRelease", "raw", "-o", "-", `${target(e)}/Contents/Info.plist`])).stdout.trim(),
    ).toBe("1.2.0")
    expect(await treeHash(previous(e))).toBe(before)
    const j = await journal(e)
    expect(j.previous_cdhash).toMatch(/^[0-9a-f]{40}$/)
    expect(j).toMatchObject({
      phase: "idle",
      run: "",
      last_apply: "1.2.0",
      previous_cdhash: oldCd,
      installed_cdhash: await cdhash(target(e)),
      target_path: target(e),
      from_release: "1.1.0",
      to_release: "1.2.0",
    })
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
    const st = await applier(e, ["status"])
    expect(st.stdout).toContain("previous_release=1.1.0\n")
    expect(st.stdout).toContain("journal_phase=idle\n")
  }))

test("AP-03 second apply 1.2.0 -> 1.3.0 keeps exactly the 1.2.0 app as backup, no expired/", () =>
  withEnv(async (e) => {
    await installApp(e)
    await applied(e, "1.2.0")
    const was = await treeHash(target(e))
    const p = await pkg(e, await buildApp(e, { release: "1.3.0" }))
    const r = await applier(e, ["apply", p.path])
    expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
    expect(await treeHash(previous(e))).toBe(was)
    expect(await fs.readdir(path.join(e.state, "previous"))).toEqual(["Swarm.app"])
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
  }))

test("AP-07 unpacked_bytes=999999999999 gives E_DISK, x/ never made", () =>
  withEnv(async (e) => {
    await installApp(e)
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }), { editManifest: tooBig })
    await expectReject(e, ["apply", p.path], "E_DISK")
  }))

test("AP-02 forward: E_CONFIRM, then applied with data_min_release=1.2.0; RK-17 backup kept until the next success", () =>
  withEnv(async (e) => {
    await installApp(e)
    const was = await treeHash(target(e))
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }), { migration: "forward", dataMinRelease: "1.2.0" })
    await expectReject(e, ["apply", p.path], "E_CONFIRM")
    const r = await applier(e, ["apply", "--accept-forward-migration", p.path])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("swarm-patch: warning: migration=forward")
    expect((await journal(e)).data_min_release).toBe("1.2.0")
    // C5: previous/ is the pre-forward app, intact, and status names why rollback is refused.
    expect(await fs.readdir(path.join(e.state, "previous"))).toEqual(["Swarm.app"])
    expect(await treeHash(previous(e))).toBe(was)
    expect((await applier(e, ["status"])).stdout).toContain("rollback_blocked=forward_migration\n")
    // A failed apply does not drop it (INV-1..4 hold and the backup hash stays).
    const big = await pkg(e, await buildApp(e, { release: "1.3.0" }), {
      fromMin: "1.2.0",
      dataMinRelease: "1.2.0",
      editManifest: tooBig,
    })
    await expectReject(e, ["apply", big.path], "E_DISK")
    expect(await treeHash(previous(e))).toBe(was)
  }))

test("AP-04 new key: E_CONFIRM with both fingerprints, then applied; RK-17 forward backup replaced, no expired/ left", () =>
  withEnv(async (e) => {
    await installApp(e)
    await applied(e, "1.2.0", { migration: "forward", dataMinRelease: "1.2.0" }, ["--accept-forward-migration"])
    const forwardApp = await treeHash(target(e))
    const s = path.join(e.root, "k_signers")
    await fs.writeFile(s, await allowedSigners(`${e.keys.k}.pub`))
    const p = await pkg(e, await buildApp(e, { release: "1.3.0", signerPub: `${e.keys.other}.pub` }), {
      fromMin: "1.2.0",
      dataMinRelease: "1.2.0",
      signers: s,
    })
    const fp = async (pub: string) => (await must(["/usr/bin/ssh-keygen", "-l", "-E", "sha256", "-f", pub])).stdout.split(" ")[1]
    const r = await expectReject(e, ["apply", p.path], "E_CONFIRM")
    expect(r.stderr).toContain(`old key ${await fp(`${e.keys.k}.pub`)}, new key ${await fp(`${e.keys.other}.pub`)}`)
    const ok = await applier(e, ["apply", "--accept-new-key", p.path])
    expect({ code: ok.code, line: ok.stdout.trim().split("\n").at(-1) }).toEqual({ code: 0, line: "new_key=yes" })
    expect((await journal(e)).data_min_release).toBe("1.2.0")
    expect(await treeHash(previous(e))).toBe(forwardApp)
    expect(await fs.readdir(path.join(e.state, "previous"))).toEqual(["Swarm.app"])
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
    await expectReject(e, ["apply", "--accept-new-key", "--accept-new-key", p.path], "E_USAGE")
    await expectReject(e, ["apply", p.path, "--accept-new-key"], "E_USAGE")
  }))

test("AP-10 (RK-10) target 'Swarm (1).app': every prefix is detected; near-miss paths are not", () =>
  withEnv(async (e) => {
    const t = path.join(e.apps, "Swarm (1).app")
    await must(["/usr/bin/ditto", await buildApp(e, { release: "1.1.0" }), t])
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
    for (const x of PREFIXES) await withHolder(`${t}/${x}`, async () => expectReject(e, ["apply", p.path], "E_RUNNING", { app: t }))
    // A regex reading of "Swarm (1).app" matches "Swarm 1Xapp"; `Contents/Resources/other` is outside the narrowed
    // pattern (RK-04). Both are visible in `pgrep -lf` before apply runs (m11), so exit 0 proves they were seen and
    // not matched.
    await withHolder(`${e.apps}/Swarm 1Xapp/Contents/MacOS/Swarm`, () =>
      withHolder(`${t}/Contents/Resources/other`, async () => {
        const r = await applier(e, ["apply", p.path], t)
        expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
      }),
    )
  }))

// D17-6: a process that starts after AP-P1 must still be caught by AP1. The holder is started as soon as
// `staging/<run>/x/` exists (V13), which is after AP-P1 and before phase 2; a 64 MB incompressible file keeps
// V13/V14 busy long enough. A20 swaps in an applier copy (mutation check on a scratchpad copy only).
test("AP1 (D17-6): a process started during extraction gives E_RUNNING with INV-1..4", () =>
  withEnv(async (e) => {
    await installApp(e, process.env.A20 ? { applier: process.env.A20 } : {})
    const t = target(e)
    const p = await pkg(
      e,
      await buildApp(e, {
        release: "1.2.0",
        mutate: (app) => fs.writeFile(path.join(app, "Contents", "Resources", "pad.bin"), randomBytes(64 << 20)),
      }),
    )
    const before = await snapshot(e, t)
    const staging = path.join(e.state, "staging")
    const call = applier(e, ["apply", p.path], t)
    const late = await (async () => {
      for (let i = 0; i < 6000; i++) {
        const runs = await fs.readdir(staging).catch(() => [] as string[])
        if (runs.length === 1 && (await fs.stat(path.join(staging, runs[0], "x")).catch(() => null))) return holder(`${t}/Contents/MacOS/Swarm`)
        await Bun.sleep(5)
      }
      throw new Error("x/ never appeared")
    })()
    try {
      const r = await call
      expect({ code: r.code, has: hasError(r, "E_RUNNING"), err: r.stderr }).toMatchObject({ code: 20, has: true })
      expect(r.stderr).toContain(`pid ${late.pid}`)
      expect(await invariants(e, before, t)).toEqual([])
    } finally {
      late.kill()
      await late.exited
    }
  }))

test("AP-08 target on another volume (disk image) gives E_VOLUME", async () => {
  const e = await createEnv()
  const img = path.join(e.root, "vol.dmg")
  const mnt = path.join(e.root, "vol")
  const made = await run(["/usr/bin/hdiutil", "create", "-size", "64m", "-fs", "HFS+", "-volname", "SPT", "-quiet", img])
  if (made.code !== 0) throw new Error(`hdiutil create exit ${made.code}: ${made.stderr.trim()}; fall back to REV-7`)
  const att = await run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-noautoopen", "-mountpoint", mnt, "-quiet", img])
  try {
    if (att.code !== 0) throw new Error(`hdiutil attach exit ${att.code}: ${att.stderr.trim()}; fall back to REV-7`)
    const t = path.join(mnt, "Swarm.app")
    await must(["/usr/bin/ditto", await buildApp(e, { release: "1.1.0" }), t])
    expect((await verifySeal(t)).code).toBe(0)
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
    await expectReject(e, ["apply", p.path], "E_VOLUME", { app: t })
  } finally {
    if (att.code === 0) await run(["/usr/bin/hdiutil", "detach", "-force", "-quiet", mnt])
    await e.cleanup()
  }
})
