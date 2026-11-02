// Row 40, m14: phase-2 failure branches of `apply` (AP6, AP7, AP8) and `rollback` (RB6, RB7, RB8), reached without
// test hooks (spec R8). A rename fails because the folder being moved is read-only: on APFS a directory moves to
// another parent only when the directory itself is writable (probed in the scratchpad). AP8 and RB8 change one
// byte of the placed app while its final check runs; a 128 MB resource keeps that check busy long enough.
// Each case asserts E_RESTORED, the installed app unchanged, the journal byte-identical (F5: data_min_release is
// not raised by a patch that was not installed), the old backup kept (M-3, C12), staging empty and the lock gone.
// Also F3 (C10) with a root-owned writable parent. Synthetic keys and fixture apps under $TMPDIR only; nothing is
// written outside it. Needs the process list: run outside the agent sandbox (protocol SB, H2).
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applier,
  buildApp,
  type Env,
  exists,
  fileHash,
  hasError,
  installApp,
  must,
  type PackageOptions,
  pkg,
  requireProcessList,
  type Result,
  treeHash,
  withEnv,
  writeJournal,
} from "./fixture"

setDefaultTimeout(300_000)

const target = (e: Env) => path.join(e.apps, "Swarm.app")
const previous = (e: Env) => path.join(e.state, "previous", "Swarm.app")

beforeAll(() => requireProcessList("phase2.test.ts"))

/** 128 MB incompressible resource, plus `zz.txt`, which sorts after it and is the byte the race changes. */
const padded = async (app: string) => {
  await fs.writeFile(path.join(app, "Contents", "Resources", "pad.bin"), randomBytes(128 << 20))
  await fs.writeFile(path.join(app, "Contents", "Resources", "zz.txt"), "z\n")
}

/** Installed 1.1.0 plus a completed apply of 1.2.0, so a valid journal and a backup exist before the failure. */
async function seedApplied(e: Env, install: Parameters<typeof installApp>[1] = {}) {
  await installApp(e, install)
  const p = await pkg(e, await buildApp(e, { release: "1.2.0" }))
  const r = await applier(e, ["apply", p.path])
  expect({ seed: "apply 1.2.0", code: r.code, err: r.stderr }).toEqual({ seed: "apply 1.2.0", code: 0, err: "" })
}

/** Everything a restored failure must leave as it was. */
async function capture(e: Env) {
  return {
    target: await treeHash(target(e)),
    previous: (await exists(previous(e))) ? await treeHash(previous(e)) : null,
    journal: await fileHash(path.join(e.state, "state")),
  }
}

async function expectRestored(e: Env, r: Result, before: Awaited<ReturnType<typeof capture>>, skipPrevious = false) {
  expect({ code: r.code, restored: hasError(r, "E_RESTORED"), stderr: r.stderr }).toMatchObject({ code: 30, restored: true })
  const after = await capture(e)
  expect(skipPrevious ? { ...after, previous: before.previous } : after).toEqual(before)
  expect({
    staging: await fs.readdir(path.join(e.state, "staging")),
    lock: await exists(path.join(e.state, "lock")),
  }).toEqual({ staging: [], lock: false })
}

/** Makes `dir` read-only (0555) for `fn`, then restores its mode, so H compares the same modes. */
async function readOnly<T>(dir: string, fn: () => Promise<T>) {
  const mode = (await fs.stat(dir)).mode & 0o7777
  await fs.chmod(dir, 0o555)
  try {
    return await fn()
  } finally {
    await fs.chmod(dir, mode)
  }
}

/** Runs `fn` once the journal records `phase`; reports whether it ran before `call` finished. */
async function onPhase(e: Env, phase: string, call: Promise<Result>, fn: () => Promise<void>) {
  const done = call.then(() => true)
  for (;;) {
    const text = await fs.readFile(path.join(e.state, "state"), "utf8").catch(() => "")
    if (text.includes(`\nphase=${phase}\n`)) {
      await fn()
      return true
    }
    if (await Promise.race([done, Bun.sleep(1).then(() => false)])) return false
  }
}

const flipZz = (app: string) => fs.appendFile(path.join(app, "Contents", "Resources", "zz.txt"), "x")

test("AP6 installed app cannot be moved: E_RESTORED; M-3 backup kept, F5 journal unchanged, rollback still works", () =>
  withEnv(async (e) => {
    await seedApplied(e)
    const before = await capture(e)
    const forward: Partial<PackageOptions> = { migration: "forward", dataMinRelease: "1.3.0", fromMin: "1.2.0" }
    const p = await pkg(e, await buildApp(e, { release: "1.3.0" }), forward)
    const r = await readOnly(target(e), () => applier(e, ["apply", "--accept-forward-migration", p.path]))
    expect(r.stdout).toMatch(/^recover_command=/)
    await expectRestored(e, r, before)
    const rb = await applier(e, ["rollback"])
    expect({ code: rb.code, out: rb.stdout }).toEqual({ code: 0, out: "result=rolled_back\nrelease=1.1.0\n" })
  }))

test("AP7 new app cannot be placed (read-only bundle folder): E_RESTORED; M-3 backup kept, journal unchanged", () =>
  withEnv(async (e) => {
    await seedApplied(e)
    const before = await capture(e)
    const app = await buildApp(e, { release: "1.3.0" })
    await fs.chmod(app, 0o555)
    const p = await pkg(e, app, { fromMin: "1.2.0" })
    await expectRestored(e, await applier(e, ["apply", p.path]), before)
  }))

test("AP8 new app fails its final check (one byte changed after placing): E_RESTORED, backup kept, journal unchanged", () =>
  withEnv(async (e) => {
    await seedApplied(e)
    const before = await capture(e)
    const p = await pkg(e, await buildApp(e, { release: "1.3.0", mutate: padded }), { fromMin: "1.2.0" })
    const call = applier(e, ["apply", p.path])
    const flipped = await onPhase(e, "new_placed", call, () => flipZz(target(e)))
    const r = await call
    expect({ flipped, code: r.code }).toMatchObject({ flipped: true })
    await expectRestored(e, r, before)
  }))

test("RB6 installed app cannot be moved aside: E_RESTORED, journal and both apps unchanged", () =>
  withEnv(async (e) => {
    await seedApplied(e)
    const before = await capture(e)
    await expectRestored(e, await readOnly(target(e), () => applier(e, ["rollback"])), before)
    expect((await applier(e, ["rollback"])).code).toBe(0)
  }))

test("RB7 backup cannot be put in place: E_RESTORED, installed app moved back, journal unchanged", () =>
  withEnv(async (e) => {
    await seedApplied(e)
    const before = await capture(e)
    await expectRestored(e, await readOnly(previous(e), () => applier(e, ["rollback"])), before)
    expect((await applier(e, ["rollback"])).code).toBe(0)
  }))

test("RB8 placed backup fails its final check (one byte changed): E_RESTORED, installed app back, journal unchanged", () =>
  withEnv(async (e) => {
    await seedApplied(e, { mutate: padded })
    const before = await capture(e)
    const call = applier(e, ["rollback"])
    const flipped = await onPhase(e, "rollback_placed", call, () => flipZz(target(e)))
    const r = await call
    expect({ flipped, code: r.code }).toMatchObject({ flipped: true })
    // The backup goes back to previous/ with the byte this test changed, so only its presence is checked.
    await expectRestored(e, r, before, true)
    expect(await exists(previous(e))).toBe(true)
  }))

// F3 (C10): a parent owned by root but writable by the user is accepted (the /Applications shape, root:admin 775).
// /private/tmp (root:wheel 1777) stands in; the journal is idle, so recover renames nothing and writes nothing there.
test("F3/C10 --target under a root-owned writable folder is accepted (idle journal: outcome=none, nothing created)", () =>
  withEnv(async (e) => {
    const t = "/private/tmp/Swarm.app"
    if (await exists(t)) throw new Error(`${t} exists on this machine; this case needs it absent`)
    await installApp(e)
    await writeJournal(e, { state_format: "1", phase: "idle", target_path: t, to_release: "1.1.0" })
    await must(["/usr/bin/ditto", target(e), previous(e)])
    const sha = await fileHash(path.join(e.state, "state"))
    const r = await applier(e, ["recover", "--target", t], previous(e))
    expect({ code: r.code, out: r.stdout, err: r.stderr }).toEqual({ code: 0, out: "result=recovered\noutcome=none\n", err: "" })
    expect({ journal: await fileHash(path.join(e.state, "state")), created: await exists(t) }).toEqual({ journal: sha, created: false })
  }))
