// ActionCheckpoint (U6, P-01b, row 37a): copy-before-act with a hashed manifest, a person-only revert that first saves the
// current bytes, keep-alive refs in a Git folder, and file copies in a folder without Git. SEC-07 (manifest sha, ref
// names, modes) and SEC-24 (the agent line names the folder) are pinned here; wiring into the gate is rows 37b/38a.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import { tmpdir } from "../fixture/fixture"

const NOW = new Date(2026, 10, 12, 9, 5, 7)
const ID = "20261112-090507-1"
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const read = (file: string) => fs.readFile(file, "utf8")
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )
const git = (cwd: string, ...args: string[]) => {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}
const mode = async (file: string) => (await fs.stat(file)).mode & 0o777

describe("tool.checkpoint", () => {
  test("round trip without Git: the copy holds the old bytes, revert puts them back, and the revert can be undone", async () => {
    await using dir = await tmpdir()
    const notes = path.join(dir.path, "notes.txt")
    await fs.writeFile(notes, "old\n")
    const lines: ActionCheckpoint.CheckpointedLine[] = []

    const made = await ActionCheckpoint.create({
      directory: dir.path,
      targets: ["notes.txt"],
      requestID: "per_1",
      sessionID: "ses_1",
      command: "echo new > notes.txt",
      record: (line) => {
        lines.push(line)
      },
      now: NOW,
    })
    if (!made.ok) throw new Error(made.message)
    expect(made.id).toBe(ID)
    expect(made.dir).toBe(path.join(dir.path, ".swarm", "checkpoint", ID))
    // The copy exists before the action runs and has the sha of the bytes the action is about to replace.
    const copy = path.join(dir.path, ".swarm/checkpoint", ID, "notes.txt")
    expect(sha(await fs.readFile(copy))).toBe(sha("old\n"))
    expect(made.manifest.mode).toBe("copy")
    expect(made.manifest.entries).toEqual([
      {
        path: "notes.txt",
        outside: false,
        rel: "notes.txt",
        existed: true,
        sha256: sha("old\n"),
        bytes: 4,
        mode: expect.any(Number),
        how: "copy",
      },
    ])
    expect(await read(path.join(dir.path, ".swarm/checkpoint/.gitignore"))).toBe("*\n")

    // The action runs.
    await fs.writeFile(notes, "new\n")

    const back = await ActionCheckpoint.revert({
      directory: dir.path,
      id: ID,
      manifestSha256: made.manifestSha256,
      record: (line) => {
        lines.push(line)
      },
    })
    if (!back.ok) throw new Error(back.message)
    expect(back.restored).toEqual(["notes.txt"])
    expect(back.verified).toBe(true)
    expect(sha(await fs.readFile(notes))).toBe(made.manifest.entries[0].sha256!)
    expect(await read(path.join(dir.path, ".swarm/checkpoint", back.preRevert, "notes.txt"))).toBe("new\n")

    // The pre-revert checkpoint is a checkpoint like any other: reverting it brings the new bytes back.
    const pre = lines.find((line) => line.checkpoint === back.preRevert)
    expect(pre).toBeDefined()
    const again = await ActionCheckpoint.revert({
      directory: dir.path,
      id: back.preRevert,
      manifestSha256: pre!.manifestSha256,
    })
    if (!again.ok) throw new Error(again.message)
    expect(await read(notes)).toBe("new\n")

    expect((await ActionCheckpoint.list(dir.path)).map((item) => item.id)).toEqual([
      ID,
      back.preRevert,
      again.preRevert,
    ])
  })

  test("the audit line carries manifestSha256 of manifest.json as written, and the agent line names the folder", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.md"), "a")
    const lines: ActionCheckpoint.CheckpointedLine[] = []
    const made = await ActionCheckpoint.create({
      directory: dir.path,
      targets: ["a.md"],
      requestID: "per_2",
      command: "sed -i s/a/b/ a.md TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123",
      record: (line) => {
        lines.push(line)
      },
      now: NOW,
    })
    if (!made.ok) throw new Error(made.message)
    const manifest = await fs.readFile(path.join(made.dir, "manifest.json"))
    expect(lines).toEqual([
      {
        type: "outcome",
        requestID: "per_2",
        outcome: "checkpointed",
        checkpoint: ID,
        entries: 1,
        bytes: 1,
        refs: 0,
        manifestSha256: sha(manifest),
      },
    ])
    expect(made.recorded).toBe(true)
    expect(manifest.toString()).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123")
    // SEC-24
    expect(ActionCheckpoint.savedText(1, ID)).toContain(`.swarm/checkpoint/${ID}`)
    expect(ActionCheckpoint.savedText(1, ID)).toBe(
      // 1.2.6 FX-2 (gate M1 S8), intended change: no emptying route exists, so the line says the person removes it by hand.
      `Swarm saved checkpoint ${ID} of 1 file(s) in .swarm/checkpoint/${ID} before this ran; the person can revert it. The checkpoint stays until the person removes it by hand.`,
    )
    // SEC-19: refs kept alive are named.
    expect(ActionCheckpoint.savedText(0, ID, 2)).toContain(`refs/swarm-checkpoint/${ID}`)
  })

  test("CK-13: a copy of .env is 0600 inside 0700 folders", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, ".env"), "API_KEY=abc\n", { mode: 0o644 })
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: [".env"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    expect(await mode(path.join(made.dir, ".env"))).toBe(0o600)
    expect(await mode(made.dir)).toBe(0o700)
    expect(await mode(path.join(dir.path, ".swarm/checkpoint"))).toBe(0o700)
    expect(await mode(path.join(made.dir, "manifest.json"))).toBe(0o600)
  })

  test("Git: refs are recorded with a keep-alive ref, and revert moves them back after a reset", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "a.txt"), "one\n")
    git(dir.path, "add", "a.txt")
    git(dir.path, "commit", "-qm", "one")
    const branch = git(dir.path, "symbolic-ref", "HEAD")
    const old = git(dir.path, "rev-parse", "HEAD")
    await fs.writeFile(path.join(dir.path, "a.txt"), "dirty\n")

    const made = await ActionCheckpoint.create({
      directory: dir.path,
      targets: ["a.txt"],
      refs: ["HEAD", branch, "refs/stash"],
      snapshot: async () => "snap-hash",
      now: NOW,
    })
    if (!made.ok) throw new Error(made.message)
    expect(made.manifest.mode).toBe("copy+snapshot")
    expect(made.manifest.snapshot).toBe("snap-hash")
    // refs/stash does not exist, so it is not recorded.
    expect(made.manifest.refs).toEqual([
      { name: "HEAD", sha: old, keep: `refs/swarm-checkpoint/${ID}/0` },
      { name: branch, sha: old, keep: `refs/swarm-checkpoint/${ID}/1` },
    ])
    expect(git(dir.path, "rev-parse", `refs/swarm-checkpoint/${ID}/0`)).toBe(old)

    git(dir.path, "reset", "-q", "--hard", "HEAD~1")
    expect(git(dir.path, "rev-parse", "HEAD")).not.toBe(old)

    const back = await ActionCheckpoint.revert({ directory: dir.path, id: ID, manifestSha256: made.manifestSha256 })
    if (!back.ok) throw new Error(back.message)
    expect(git(dir.path, "rev-parse", "HEAD")).toBe(old)
    expect(await read(path.join(dir.path, "a.txt"))).toBe("dirty\n")
  })

  test("SEC-07: ref names that are not HEAD or a valid refs/... name are refused and nothing is saved", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "a.txt"), "x")
    for (const name of ["--stdin", "../x", "refs/../x", "refs/heads/a b", "refs/swarm-checkpoint/x/0"]) {
      const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["a.txt"], refs: [name], now: NOW })
      expect(made.ok).toBe(false)
      if (!made.ok) expect(made.reason).toBe("git")
    }
    expect(await ActionCheckpoint.list(dir.path)).toEqual([])
  })

  test("refs in a folder without Git are refused", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.txt"), "x")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["a.txt"], refs: ["HEAD"], now: NOW })
    expect(made.ok).toBe(false)
    if (!made.ok) expect(made.reason).toBe("git")
  })

  test("SEC-07: a revert after manifest.json was edited restores nothing", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "notes.txt")
    await fs.writeFile(file, "old\n")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["notes.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    await fs.writeFile(file, "new\n")
    const manifestFile = path.join(made.dir, "manifest.json")
    const text = await read(manifestFile)
    await fs.writeFile(manifestFile, text.replace('"targets": [', '"targets": [\n    "../../etc",'))

    const back = await ActionCheckpoint.revert({ directory: dir.path, id: ID, manifestSha256: made.manifestSha256 })
    expect(back).toMatchObject({ ok: false, reason: "tampered" })
    expect(await read(file)).toBe("new\n")
    expect((await ActionCheckpoint.list(dir.path)).length).toBe(1)
  })

  test("a copy changed after creation is refused at revert", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "notes.txt")
    await fs.writeFile(file, "old\n")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["notes.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    await fs.writeFile(file, "new\n")
    await fs.writeFile(path.join(made.dir, "notes.txt"), "evil\n")
    const back = await ActionCheckpoint.revert({ directory: dir.path, id: ID, manifestSha256: made.manifestSha256 })
    expect(back).toMatchObject({ ok: false, reason: "mismatch" })
    expect(await read(file)).toBe("new\n")
  })

  test("an unknown id is not found and makes no pre-revert checkpoint", async () => {
    await using dir = await tmpdir()
    const back = await ActionCheckpoint.revert({
      directory: dir.path,
      id: "20261112-000000-1",
      manifestSha256: "0".repeat(64),
    })
    expect(back).toMatchObject({ ok: false, reason: "not_found" })
    const traversal = await ActionCheckpoint.revert({ directory: dir.path, id: "../x", manifestSha256: "0".repeat(64) })
    expect(traversal).toMatchObject({ ok: false, reason: "not_found" })
    expect(await exists(path.join(dir.path, ".swarm"))).toBe(false)
  })

  test("CK-9: over the cap or a linked .swarm is refused with nothing saved and the target unchanged", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "big.bin"), Buffer.alloc(2048))
    const big = await ActionCheckpoint.create({ directory: dir.path, targets: ["big.bin"], maxBytes: 1024, now: NOW })
    expect(big).toMatchObject({ ok: false, reason: "too_large" })
    expect(await exists(path.join(dir.path, ".swarm"))).toBe(false)

    await using elsewhere = await tmpdir()
    await fs.symlink(elsewhere.path, path.join(dir.path, ".swarm"))
    const linked = await ActionCheckpoint.create({ directory: dir.path, targets: ["big.bin"], now: NOW })
    expect(linked).toMatchObject({ ok: false, reason: "checkpoint_link" })
    expect(await fs.readdir(elsewhere.path)).toEqual([])
    expect((await fs.readFile(path.join(dir.path, "big.bin"))).length).toBe(2048)
  })

  test("a target made after the checkpoint is moved to the archive on revert, never deleted", async () => {
    await using dir = await tmpdir()
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["later.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    expect(made.manifest.entries).toEqual([
      { path: "later.txt", outside: false, rel: "later.txt", existed: false, bytes: 0, how: "copy" },
    ])
    await fs.writeFile(path.join(dir.path, "later.txt"), "made later")
    const back = await ActionCheckpoint.revert({ directory: dir.path, id: ID, manifestSha256: made.manifestSha256 })
    if (!back.ok) throw new Error(back.message)
    expect(await exists(path.join(dir.path, "later.txt"))).toBe(false)
    const archived = await fs.readdir(path.join(dir.path, ".swarm/archive"))
    expect(archived.filter((name) => name !== ".gitignore").length).toBe(1)
  })

  test("outside the folder: refused unless allowed for an existing file, then copied under _outside", async () => {
    await using dir = await tmpdir()
    await using other = await tmpdir()
    const target = path.join(other.path, "a.ts")
    await fs.writeFile(target, "outside")
    expect(await ActionCheckpoint.create({ directory: dir.path, targets: [target], now: NOW })).toMatchObject({
      ok: false,
      reason: "outside",
    })
    expect(
      await ActionCheckpoint.create({ directory: dir.path, targets: [other.path], allowOutside: true, now: NOW }),
    ).toMatchObject({ ok: false, reason: "outside" })
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: [target], allowOutside: true, now: NOW })
    if (!made.ok) throw new Error(made.message)
    const rel = made.manifest.entries[0].rel
    expect(rel.startsWith("_outside/")).toBe(true)
    expect(await read(path.join(made.dir, rel))).toBe("outside")
    await fs.writeFile(target, "changed")
    const back = await ActionCheckpoint.revert({ directory: dir.path, id: ID, manifestSha256: made.manifestSha256 })
    if (!back.ok) throw new Error(back.message)
    expect(await read(target)).toBe("outside")
  })

  test("the checkpoint area itself cannot be a target", async () => {
    await using dir = await tmpdir()
    expect(await ActionCheckpoint.create({ directory: dir.path, targets: [".swarm"], now: NOW })).toMatchObject({
      ok: false,
      reason: "checkpoint",
    })
  })
})
