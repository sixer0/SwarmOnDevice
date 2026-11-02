// Row 43: `rollback` and `recover` suite (spec 9.7 RB-01..RB-09, 9.8 RC-01..RC-15; RC-10 per RK-18/C4), moved from
// the row 18 smoke checks. Every breakpoint is seeded with renames and a journal written here; the applier has no test
// hooks. Readings D18-1..D18-5 and C8 (B5 seal check runs before `recover`, so a one-byte change to the bundle that
// runs the applier gives E_SEAL; RC-09 and RC-12 also use a valid other app with a different CDHash).
// INV-4 is asserted for every case by withEnv. Synthetic keys and fixture apps under $TMPDIR only.
// Needs the process list: run outside the agent sandbox (protocol SB, H2). In the sandbox `pgrep` exits >= 2 and
// beforeAll fails every case with that reason; nothing is skipped.
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applier,
  buildApp,
  cdhash,
  type Env,
  exists,
  expectReject,
  fileHash,
  hasError,
  installApp,
  journal,
  JOURNAL_KEYS,
  must,
  pkg,
  requireProcessList,
  stateDirs,
  treeHash,
  withEnv,
  withHolder,
  writeJournal,
} from "./fixture"

setDefaultTimeout(180_000)

const RUN = "1700000000-4242"
const tgt = (e: Env) => path.join(e.apps, "Swarm.app")
const prev = (e: Env) => path.join(e.state, "previous", "Swarm.app")
const runDir = (e: Env) => path.join(e.state, "staging", RUN)
const sha = async (f: string) => (await fileHash(f)) ?? ""
const dir700 = async (p: string) => {
  await fs.mkdir(p, { recursive: true })
  await fs.chmod(p, 0o700)
}
const flip = (app: string) => fs.appendFile(path.join(app, "Contents", "Resources", "data.txt"), "x")
beforeAll(() => requireProcessList("rollback-recover.test.ts"))
// Old 1.1.0 installed, new 1.2.0 built aside. Base journal values for a 1.1.0 -> 1.2.0 apply.
async function seedBase(e: Env) {
  await installApp(e)
  const nu = await buildApp(e, { release: "1.2.0" })
  const oldCd = await cdhash(tgt(e))
  const newCd = await cdhash(nu)
  const j = {
    state_format: "1", run: RUN, target_path: tgt(e), from_release: "1.1.0", to_release: "1.2.0",
    data_min_release: "1.0.0", started_at: "1700000000", payload_sha256: "a".repeat(64), previous_cdhash: oldCd,
  }
  await stateDirs(e)
  await dir700(runDir(e))
  return { nu, oldCd, newCd, j }
}
// After a completed apply: target = new, previous = old.
async function seedApplied(e: Env) {
  const b = await seedBase(e)
  await fs.rename(tgt(e), prev(e))
  await fs.rename(b.nu, tgt(e))
  const idle = { ...b.j, phase: "idle", run: "", started_at: "", installed_cdhash: b.newCd, last_apply: "1.2.0" }
  return { ...b, idle }
}
const ok = (r: { code: number; stdout: string; stderr: string }, lines: string[]) =>
  expect({ code: r.code, out: r.stdout.trim().split("\n"), err: r.stderr }).toEqual({ code: 0, out: lines, err: "" })

test("RC-11 invalid journal and state_format=2 give E_BUSY without changes", () =>
  withEnv(async (e) => {
    await installApp(e)
    await writeJournal(e, { state_format: "1", phase: "bogus" })
    await expectReject(e, ["recover"], "E_BUSY")
    await writeJournal(e, { state_format: "2", phase: "idle" })
    await expectReject(e, ["recover"], "E_BUSY")
    await expectReject(e, ["rollback"], "E_BUSY")
  }))

test("RB-01 apply then rollback restores the old app; RB-02 second rollback E_MIGRATION", () =>
  withEnv(async (e) => {
    await installApp(e)
    const before = await treeHash(tgt(e))
    const oldCd = await cdhash(tgt(e))
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
    expect((await applier(e, ["apply", p.path])).code).toBe(0)
    const r = await applier(e, ["rollback"])
    ok(r, ["result=rolled_back", "release=1.1.0"])
    expect(await treeHash(tgt(e))).toBe(before)
    expect(await exists(prev(e))).toBe(false)
    const j = await journal(e)
    expect({ phase: j.phase, installed_cdhash: j.installed_cdhash, previous_cdhash: j.previous_cdhash, to_release: j.to_release, last_apply: j.last_apply, from_release: j.from_release }).toEqual({
      phase: "idle", installed_cdhash: oldCd, previous_cdhash: "", to_release: "1.1.0", last_apply: "1.2.0", from_release: "",
    })
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
    await expectReject(e, ["rollback"], "E_MIGRATION")
    expect((await applier(e, ["rollback", "x"])).code).toBe(2)
  }))

test("RB-03/RB-09 after forward: E_MIGRATION, backup kept, status gives the reason", () =>
  withEnv(async (e) => {
    await installApp(e)
    const p = await pkg(e, await buildApp(e, { release: "1.2.0" }), { migration: "forward", dataMinRelease: "1.2.0" })
    expect((await applier(e, ["apply", "--accept-forward-migration", p.path])).code).toBe(0)
    const hp = await treeHash(prev(e))
    const r = await expectReject(e, ["rollback"], "E_MIGRATION")
    expect(r.stderr).toContain("migration=forward")
    expect(await treeHash(prev(e))).toBe(hp)
    expect((await applier(e, ["status"])).stdout).toContain("rollback_blocked=forward_migration\n")
  }))

test("RB-04 backup one byte changed, RB-05 target replaced, RB-06 no journal, RB-07 new_placed, RB-08 running", () =>
  withEnv(async (e) => {
    const r6 = await expectReject(e, ["rollback"], "E_MIGRATION", { app: await installApp(e) })
    expect(r6.stderr).toContain("nothing to roll back")
    await fs.rm(tgt(e), { recursive: true })
    const s = await seedApplied(e)
    await writeJournal(e, s.idle)
    // RB-08: a process from the target and one from the backup.
    for (const w of [`${tgt(e)}/Contents/MacOS/Swarm`, `${prev(e)}/Contents/Frameworks/x`])
      await withHolder(w, () => expectReject(e, ["rollback"], "E_RUNNING"))
    // RB-07
    await writeJournal(e, { ...s.idle, phase: "new_placed", run: RUN })
    await expectReject(e, ["rollback"], "E_BUSY")
    await writeJournal(e, s.idle)
    // RB-05: a valid other app with a different CDHash at the target.
    const other = await buildApp(e, { release: "1.2.0", mutate: (a) => flip(a) })
    const keep = path.join(e.root, "keep.app")
    await fs.rename(tgt(e), keep)
    await fs.rename(other, tgt(e))
    expect(await cdhash(tgt(e))).not.toBe(s.newCd)
    expect((await expectReject(e, ["rollback"], "E_MIGRATION")).stderr).toContain("replaced outside")
    await fs.rm(tgt(e), { recursive: true })
    await fs.rename(keep, tgt(e))
    // RB-04
    await flip(prev(e))
    const hp = await treeHash(prev(e))
    await expectReject(e, ["rollback"], "E_MIGRATION")
    expect(await treeHash(prev(e))).toBe(hp)
  }))

test("RC-01 no journal and idle journal give outcome=none", () =>
  withEnv(async (e) => {
    await installApp(e)
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=none"])
    await writeJournal(e, { state_format: "1", phase: "idle", target_path: tgt(e) })
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=none"])
    await expectReject(e, ["recover", "--target", tgt(e)], "E_USAGE")
  }))

test("RC-02 staged: restored, target unchanged, staging and previous empty", () =>
  withEnv(async (e) => {
    const s = await seedBase(e)
    await dir700(path.join(runDir(e), "x"))
    await dir700(path.join(runDir(e), "expired"))
    await fs.rename(s.nu, path.join(runDir(e), "x", "Swarm.app"))
    await must(["/usr/bin/ditto", tgt(e), path.join(runDir(e), "expired", "Swarm.app")])
    await writeJournal(e, { ...s.j, phase: "staged" })
    const h = await treeHash(tgt(e))
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(h)
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
    expect(await fs.readdir(path.join(e.state, "previous"))).toEqual([])
    const j = await journal(e)
    expect({ phase: j.phase, installed_cdhash: j.installed_cdhash, to_release: j.to_release, previous_cdhash: j.previous_cdhash }).toEqual({
      phase: "idle", installed_cdhash: s.oldCd, to_release: "1.1.0", previous_cdhash: "",
    })
  }))

async function seedOldMoved(e: Env) {
  const s = await seedBase(e)
  const h = await treeHash(tgt(e))
  await fs.rename(tgt(e), prev(e))
  await dir700(path.join(runDir(e), "x"))
  await fs.rename(s.nu, path.join(runDir(e), "x", "Swarm.app"))
  await writeJournal(e, { ...s.j, phase: "old_moved" })
  return { ...s, h }
}

test("RC-03/RC-10 old_moved from the backup copy with --target: restored", () =>
  withEnv(async (e) => {
    const s = await seedOldMoved(e)
    ok(await applier(e, ["recover", "--target", tgt(e)], prev(e)), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(s.h)
    expect(await exists(prev(e))).toBe(false)
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
    expect((await journal(e)).phase).toBe("idle")
  }))

test("RC-13/RC-14/RC-15 backup mode argument checks give E_USAGE without changes", () =>
  withEnv(async (e) => {
    await seedOldMoved(e)
    const js = await sha(path.join(e.state, "state"))
    const hb = await treeHash(prev(e))
    const bad = async (args: string[]) => {
      const r = await applier(e, args, prev(e))
      expect({ code: r.code, has: hasError(r, "E_USAGE") }).toEqual({ code: 2, has: true })
      expect(await sha(path.join(e.state, "state"))).toBe(js)
      expect(await treeHash(prev(e))).toBe(hb)
      expect(await exists(tgt(e))).toBe(false)
    }
    await bad(["recover"])                                          // RC-14
    await bad(["recover", "--target", path.join(e.root, "Swarm.app")]) // RC-13
    await bad(["recover", "--target", `${tgt(e)}/`])
    await bad(["recover", "--target"])
    await bad(["rollback"])
    // RC-15 symlink parent: journal and argument both name the link path.
    const link = path.join(e.root, "linked")
    await fs.symlink(e.apps, link)
    await writeJournal(e, { ...(await journal(e)), target_path: path.join(link, "Swarm.app") })
    const js2 = await sha(path.join(e.state, "state"))
    const r = await applier(e, ["recover", "--target", path.join(link, "Swarm.app")], prev(e))
    expect({ code: r.code, sym: r.stderr.includes("symlink"), same: (await sha(path.join(e.state, "state"))) === js2 }).toEqual({ code: 2, sym: true, same: true })
    // RC-15 basename not Swarm.app
    const other = path.join(e.apps, "Other.app")
    await writeJournal(e, { ...(await journal(e)), target_path: other })
    const r2 = await applier(e, ["recover", "--target", other], prev(e))
    expect({ code: r2.code, msg: r2.stderr.includes("/Swarm.app") }).toEqual({ code: 2, msg: true })
    // RC-15 symlinked Swarm.app itself
    await writeJournal(e, { ...(await journal(e)), target_path: tgt(e) })
    await fs.symlink(path.join(e.root, "nowhere"), tgt(e))
    const r3 = await applier(e, ["recover", "--target", tgt(e)], prev(e))
    expect({ code: r3.code, sym: r3.stderr.includes("symlink") }).toEqual({ code: 2, sym: true })
    await fs.unlink(tgt(e))
    // RC-15 folder of another account that the user cannot write (C10): /usr exists, has no symlink component.
    await writeJournal(e, { ...(await journal(e)), target_path: "/usr/Swarm.app" })
    const js3 = await sha(path.join(e.state, "state"))
    const r4 = await applier(e, ["recover", "--target", "/usr/Swarm.app"], prev(e))
    expect({ code: r4.code, owner: r4.stderr.includes("not writable by the current user"), same: (await sha(path.join(e.state, "state"))) === js3 }).toEqual({ code: 2, owner: true, same: true })
    expect(await treeHash(prev(e))).toBe(hb)
  }))

test("RC-12 old_moved, backup replaced by another valid app: E_RECOVER; one-byte change: E_SEAL; nothing changed", () =>
  withEnv(async (e) => {
    const s = await seedOldMoved(e)
    const js = await sha(path.join(e.state, "state"))
    const other = await buildApp(e, { release: "1.1.0", mutate: (a) => flip(a) })
    const keep = path.join(e.root, "keep.app")
    await fs.rename(prev(e), keep)
    await fs.rename(other, prev(e))
    const hb = await treeHash(prev(e))
    const r = await applier(e, ["recover", "--target", tgt(e)], prev(e))
    expect({ code: r.code, has: hasError(r, "E_RECOVER") }).toEqual({ code: 31, has: true })
    expect(r.stderr).toContain(`target ${tgt(e)}`)
    expect({ h: await treeHash(prev(e)), j: await sha(path.join(e.state, "state")), t: await exists(tgt(e)) }).toEqual({ h: hb, j: js, t: false })
    await fs.rm(prev(e), { recursive: true })
    await fs.rename(keep, prev(e))
    await flip(prev(e))
    const r2 = await applier(e, ["recover", "--target", tgt(e)], prev(e))
    expect({ code: r2.code, has: hasError(r2, "E_SEAL"), j: (await sha(path.join(e.state, "state"))) === js }).toEqual({ code: 15, has: true, j: true })
    expect(s.h).not.toBe(await treeHash(prev(e)))
  }))

async function seedNewPlaced(e: Env, bad: boolean) {
  const s = await seedBase(e)
  const hOld = await treeHash(tgt(e))
  await fs.rename(tgt(e), prev(e))
  if (bad) await flip(s.nu)
  await fs.rename(s.nu, tgt(e))
  await writeJournal(e, { ...s.j, phase: "new_placed" })
  return { ...s, hOld }
}

test("RC-04 new_placed with a valid new app: completed", () =>
  withEnv(async (e) => {
    const s = await seedNewPlaced(e, false)
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=completed"])
    const j = await journal(e)
    expect({ phase: j.phase, last_apply: j.last_apply, installed_cdhash: j.installed_cdhash, previous_cdhash: j.previous_cdhash }).toEqual({
      phase: "idle", last_apply: "1.2.0", installed_cdhash: s.newCd, previous_cdhash: s.oldCd,
    })
    expect(await exists(prev(e))).toBe(true)
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
  }))

test("RC-05 new_placed with a changed new app: restored from the backup copy", () =>
  withEnv(async (e) => {
    const s = await seedNewPlaced(e, true)
    expect(hasError(await applier(e, ["recover"]), "E_SEAL")).toBe(true)
    ok(await applier(e, ["recover", "--target", tgt(e)], prev(e)), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(s.hOld)
    expect((await journal(e)).installed_cdhash).toBe(s.oldCd)
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
  }))

async function seedRollback(e: Env, phase: string) {
  const s = await seedApplied(e)
  const hNew = await treeHash(tgt(e))
  const disc = path.join(runDir(e), "discard")
  if (phase !== "rollback_staged") {
    await dir700(disc)
    await fs.rename(tgt(e), path.join(disc, "Swarm.app"))
  }
  if (phase === "rollback_placed") await fs.rename(prev(e), tgt(e))
  await writeJournal(e, { ...s.idle, phase, run: RUN, started_at: "1700000001" })
  return { ...s, hNew }
}

test("RC-06 rollback_staged: restored, target unchanged", () =>
  withEnv(async (e) => {
    const s = await seedRollback(e, "rollback_staged")
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(s.hNew)
    const j = await journal(e)
    expect(j).toEqual(Object.fromEntries(JOURNAL_KEYS.map((k) => [k, (s.idle as Record<string, string>)[k] ?? ""])))
  }))

test("RC-07 rollback_moved: restored from discard via the backup copy", () =>
  withEnv(async (e) => {
    const s = await seedRollback(e, "rollback_moved")
    ok(await applier(e, ["recover", "--target", tgt(e)], prev(e)), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(s.hNew)
    expect(await exists(prev(e))).toBe(true)
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
  }))

test("RC-08 rollback_placed with a valid backup: completed", () =>
  withEnv(async (e) => {
    const s = await seedRollback(e, "rollback_placed")
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=completed"])
    const j = await journal(e)
    expect({ phase: j.phase, installed_cdhash: j.installed_cdhash, previous_cdhash: j.previous_cdhash, to_release: j.to_release }).toEqual({
      phase: "idle", installed_cdhash: s.oldCd, previous_cdhash: "", to_release: "1.1.0",
    })
    expect(await fs.readdir(path.join(e.state, "staging"))).toEqual([])
  }))

test("RC-09 rollback_placed, target replaced by another valid app: restored from discard", () =>
  withEnv(async (e) => {
    const s = await seedRollback(e, "rollback_placed")
    const other = await buildApp(e, { release: "1.1.0", mutate: (a) => flip(a) })
    await fs.rm(tgt(e), { recursive: true })
    await fs.rename(other, tgt(e))
    const hOther = await treeHash(tgt(e))
    ok(await applier(e, ["recover"]), ["result=recovered", "outcome=restored"])
    expect(await treeHash(tgt(e))).toBe(s.hNew)
    expect(await treeHash(prev(e))).toBe(hOther)
    expect((await journal(e)).phase).toBe("idle")
  }))
