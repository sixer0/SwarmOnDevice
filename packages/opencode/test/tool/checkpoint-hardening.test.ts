// ActionCheckpoint hardening (1.2.6 row FX-2, gate M1 S2/S4/S8). S2: a file is hashed by streaming it, never read whole
// into memory (the cap is 1 GiB). S4: reverts in one folder run one after the other, and every temporary name is unique, so
// two reverts (or two checkpoints) never collide. S8: no route empties checkpoints in 1.2.6, so the agent text never
// promises one; it names the folder and says the person removes it by hand.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import { tmpdir } from "../fixture/fixture"

const NOW = new Date(2026, 10, 12, 9, 5, 7)
const ID = "20261112-090507-1"
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const streamSha = async (file: string) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}
const manifestOf = async (root: string, id: string) =>
  JSON.parse(await fs.readFile(path.join(root, ".swarm/checkpoint", id, "manifest.json"), "utf8")) as ActionCheckpoint.Manifest

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

describe("S2: hashing streams the file", () => {
  test("a large file is checkpointed and reverted without being read whole into memory, with the same sha", async () => {
    await using dir = await tmpdir()
    const big = path.join(dir.path, "big.bin")
    const size = 48 * 1024 * 1024 + 123
    // Sparse body with real bytes at both ends, so the sha depends on the whole length and on the content.
    await fs.writeFile(big, "head-bytes\n")
    await fs.truncate(big, size)
    const handle = await fs.open(big, "r+")
    await handle.write(Buffer.from("tail-bytes\n"), 0, 11, size - 11)
    await handle.close()
    const expected = await streamSha(big)

    const readFile = spyOn(fs, "readFile")
    spies.push(readFile)
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["big.bin"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    expect(made.manifest.entries[0].sha256).toBe(expected)
    expect(made.manifest.entries[0].bytes).toBe(size)
    expect(await streamSha(path.join(made.dir, "big.bin"))).toBe(expected)

    await fs.writeFile(big, "changed\n")
    const back = await ActionCheckpoint.revert({ directory: dir.path, id: made.id, manifestSha256: made.manifestSha256 })
    if (!back.ok) throw new Error(back.message)
    expect((await fs.stat(big)).size).toBe(size)
    expect(await streamSha(big)).toBe(expected)

    // Neither the target, its copy nor the restored file was ever read whole: only small manifests go through readFile.
    const whole = readFile.mock.calls.map((call) => String(call[0])).filter((file) => file.endsWith("big.bin"))
    expect(whole).toEqual([])
  }, 60_000)
})

describe("S4: reverts are serialised and temporary names are unique", () => {
  test("two parallel reverts of one checkpoint: the second waits for the first, both succeed, nothing is left over", async () => {
    await using dir = await tmpdir()
    const notes = path.join(dir.path, "notes.txt")
    await fs.writeFile(notes, "old\n")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["notes.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    await fs.writeFile(notes, "new\n")

    const input = { directory: dir.path, id: made.id, manifestSha256: made.manifestSha256 }
    const [a, b] = await Promise.all([ActionCheckpoint.revert(input), ActionCheckpoint.revert(input)])
    if (!a.ok) throw new Error(a.message)
    if (!b.ok) throw new Error(b.message)
    expect(await fs.readFile(notes, "utf8")).toBe("old\n")
    expect(a.preRevert).not.toBe(b.preRevert)

    // One revert saw "new" before it restored; the other ran only after that and saw the restored "old".
    const seen = await Promise.all(
      [a.preRevert, b.preRevert].map(async (id) => (await manifestOf(dir.path, id)).entries[0].sha256),
    )
    expect(seen.toSorted()).toEqual([sha("new\n"), sha("old\n")].toSorted())
    expect((await fs.readdir(dir.path)).filter((name) => name.includes(".swarm-revert"))).toEqual([])
  })

  test("a leftover temporary file from an earlier revert does not make the next revert fail", async () => {
    await using dir = await tmpdir()
    const notes = path.join(dir.path, "notes.txt")
    await fs.writeFile(notes, "old\n")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["notes.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    await fs.writeFile(notes, "new\n")
    const stale = `${notes}.swarm-revert-${process.pid}.tmp`
    await fs.writeFile(stale, "stale\n")

    const back = await ActionCheckpoint.revert({ directory: dir.path, id: made.id, manifestSha256: made.manifestSha256 })
    if (!back.ok) throw new Error(back.message)
    expect(await fs.readFile(notes, "utf8")).toBe("old\n")
    expect(await fs.readFile(stale, "utf8")).toBe("stale\n")
  })

  test("two checkpoints made at once in a fresh folder both succeed", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.txt"), "a\n")
    await fs.writeFile(path.join(dir.path, "b.txt"), "b\n")
    const [a, b] = await Promise.all([
      ActionCheckpoint.create({ directory: dir.path, targets: ["a.txt"], now: NOW }),
      ActionCheckpoint.create({ directory: dir.path, targets: ["b.txt"], now: NOW }),
    ])
    if (!a.ok) throw new Error(a.message)
    if (!b.ok) throw new Error(b.message)
    expect([a.id, b.id].toSorted()).toEqual([ID, "20261112-090507-2"])
    expect(await fs.readFile(path.join(dir.path, ".swarm/checkpoint/.gitignore"), "utf8")).toBe("*\n")
    expect((await fs.readdir(path.join(dir.path, ".swarm/checkpoint"))).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    )
  })
})

describe("S8: no text promises a way to empty checkpoints", () => {
  test("the agent line names the folder and says the person removes it by hand, with or without refs", () => {
    for (const text of [ActionCheckpoint.savedText(1, ID), ActionCheckpoint.savedText(0, ID, 2)]) {
      expect(text).toContain(`.swarm/checkpoint/${ID}`)
      expect(text).toContain("the person removes it by hand")
      expect(text).not.toMatch(/empt/i)
    }
    expect(ActionCheckpoint.savedText(0, ID, 2)).toContain(`Old commits stay under refs/swarm-checkpoint/${ID}`)
  })

  test("the refusal for a target inside the checkpoint area does not promise emptying either", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.txt"), "a\n")
    const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["a.txt"], now: NOW })
    if (!made.ok) throw new Error(made.message)
    const refused = await ActionCheckpoint.create({ directory: dir.path, targets: [".swarm/checkpoint"], now: NOW })
    if (refused.ok) throw new Error("a checkpoint of the checkpoint area was made")
    expect(refused.reason).toBe("checkpoint")
    expect(refused.message).not.toMatch(/empt/i)
    expect(refused.message).toContain("by hand")
  })
})
