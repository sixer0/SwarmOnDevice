// What the archive does in place of a deletion (U11 rule 4): it moves, never follows a link, and keeps the project's
// `.gitignore` as it was.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Archive } from "../../src/tool/archive"
import { tmpdir } from "../fixture/fixture"

const NOW = new Date(2026, 10, 2, 9, 5, 7)
const ID = "20261102-090507-1"

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

describe("tool.archive", () => {
  test("moves a folder and a file under one entry and writes an archived line", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.mkdir(path.join(dir.path, "build", "out"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "build", "out", "a.js"), "aaaa")
    await fs.writeFile(path.join(dir.path, "notes.txt"), "nn")
    const lines: Archive.ArchivedLine[] = []

    const result = await Archive.move({
      directory: dir.path,
      paths: ["build", "notes.txt"],
      requestID: "per_1",
      record: (line) => {
        lines.push(line)
      },
      now: NOW,
    })

    expect(result).toEqual({
      ok: true,
      id: ID,
      moved: [
        { from: "build", to: `.swarm/archive/${ID}/build` },
        { from: "notes.txt", to: `.swarm/archive/${ID}/notes.txt` },
      ],
      missing: [],
      bytes: 6,
      recorded: true,
    })
    expect(await exists(path.join(dir.path, "build"))).toBe(false)
    expect(await fs.readFile(path.join(dir.path, ".swarm/archive", ID, "build/out/a.js"), "utf8")).toBe("aaaa")
    expect(lines).toEqual([
      {
        type: "outcome",
        requestID: "per_1",
        outcome: "archived",
        archive: ID,
        moved: [
          { from: "build", to: `.swarm/archive/${ID}/build` },
          { from: "notes.txt", to: `.swarm/archive/${ID}/notes.txt` },
        ],
        bytes: 6,
      },
    ])
    expect(Archive.movedText(2, ID)).toBe(
      `Swarm moved 2 path(s) to .swarm/archive/${ID} instead of deleting them. The person empties the archive when they return.`,
    )
  })

  test("leaves the project's .gitignore alone and git sees nothing of the archive", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, ".gitignore"), "node_modules\n")
    await fs.writeFile(path.join(dir.path, "x.txt"), "x")
    spawnSync("git", ["add", "-A"], { cwd: dir.path })
    spawnSync("git", ["commit", "-qm", "x"], { cwd: dir.path })

    const result = await Archive.move({ directory: dir.path, paths: ["x.txt"], now: NOW })

    expect(result.ok).toBe(true)
    expect(await fs.readFile(path.join(dir.path, ".gitignore"), "utf8")).toBe("node_modules\n")
    expect(await fs.readFile(path.join(dir.path, ".swarm/archive/.gitignore"), "utf8")).toBe("*\n")
    spawnSync("git", ["add", "-A"], { cwd: dir.path })
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir.path, encoding: "utf8" }).stdout
    // The deletion of the tracked file shows; nothing under .swarm does.
    expect(status.trim().split("\n")).toEqual(["D  x.txt"])
  })

  test("an archive or .swarm that is a link is refused and nothing moves", async () => {
    for (const linked of [".swarm", ".swarm/archive"]) {
      await using dir = await tmpdir()
      await using away = await tmpdir()
      await fs.writeFile(path.join(dir.path, "a.txt"), "a")
      if (linked === ".swarm/archive") await fs.mkdir(path.join(dir.path, ".swarm"))
      await fs.symlink(away.path, path.join(dir.path, linked))

      const result = await Archive.move({ directory: dir.path, paths: ["a.txt"], now: NOW })

      expect(result).toMatchObject({ ok: false, reason: "archive_link" })
      expect(await exists(path.join(dir.path, "a.txt"))).toBe(true)
      expect(await fs.readdir(away.path)).toEqual([])
      expect(await Archive.folder(dir.path)).toBeUndefined()
    }
  })

  test("an archive .gitignore that is a link is refused", async () => {
    await using dir = await tmpdir()
    await using away = await tmpdir()
    await fs.mkdir(path.join(dir.path, ".swarm/archive"), { recursive: true })
    await fs.writeFile(path.join(away.path, "target"), "keep")
    await fs.symlink(path.join(away.path, "target"), path.join(dir.path, ".swarm/archive/.gitignore"))
    await fs.writeFile(path.join(dir.path, "a.txt"), "a")

    const result = await Archive.move({ directory: dir.path, paths: ["a.txt"], now: NOW })

    expect(result).toMatchObject({ ok: false, reason: "archive_link" })
    expect(await fs.readFile(path.join(away.path, "target"), "utf8")).toBe("keep")
    expect(await exists(path.join(dir.path, "a.txt"))).toBe(true)
  })

  test("a link is moved as the link, and its target stays", async () => {
    await using dir = await tmpdir()
    await using away = await tmpdir()
    await fs.writeFile(path.join(away.path, "real.txt"), "real")
    await fs.symlink(path.join(away.path, "real.txt"), path.join(dir.path, "link"))

    const result = await Archive.move({ directory: dir.path, paths: ["link"], now: NOW })

    expect(result).toMatchObject({ ok: true, moved: [{ from: "link", to: `.swarm/archive/${ID}/link` }] })
    expect((await fs.lstat(path.join(dir.path, ".swarm/archive", ID, "link"))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(away.path, "real.txt"), "utf8")).toBe("real")
  })

  test("a path whose parent is a link out of the folder is refused", async () => {
    await using dir = await tmpdir()
    await using away = await tmpdir()
    await fs.writeFile(path.join(away.path, "victim.txt"), "v")
    await fs.symlink(away.path, path.join(dir.path, "out"))

    const result = await Archive.move({ directory: dir.path, paths: ["out/victim.txt"], now: NOW })

    expect(result).toMatchObject({ ok: false, reason: "outside" })
    expect(await exists(path.join(away.path, "victim.txt"))).toBe(true)
  })

  test("paths outside the folder, the folder itself, and the archive are refused", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, ".swarm/archive/old"), { recursive: true })
    await fs.mkdir(path.join(dir.path, "sub"))

    for (const [item, reason] of [
      ["../elsewhere", "outside"],
      [".", "outside"],
      ["/etc/hosts", "outside"],
      [".swarm", "archive"],
      [".swarm/archive", "archive"],
      [".swarm/archive/old", "archive"],
      ["sub/../.swarm", "archive"],
    ] as const) {
      const result = await Archive.move({ directory: dir.path, paths: [item], now: NOW })
      expect(result).toMatchObject({ ok: false, reason })
    }
    expect(await exists(path.join(dir.path, ".swarm/archive/old"))).toBe(true)
  })

  test("a refusal on the second path moves none of them", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.txt"), "a")

    const result = await Archive.move({ directory: dir.path, paths: ["a.txt", "../x"], now: NOW })

    expect(result).toMatchObject({ ok: false, reason: "outside" })
    expect(await exists(path.join(dir.path, "a.txt"))).toBe(true)
  })

  test("names that collide get their own entry, and nested paths move once", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "a.txt"), "first")
    const first = await Archive.move({ directory: dir.path, paths: ["a.txt"], now: NOW })
    await fs.mkdir(path.join(dir.path, "d/e"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "a.txt"), "second")
    await fs.writeFile(path.join(dir.path, "d/e/f.txt"), "f")
    const second = await Archive.move({ directory: dir.path, paths: ["a.txt", "d/e/f.txt", "d", "a.txt"], now: NOW })

    expect(first).toMatchObject({ ok: true, id: "20261102-090507-1" })
    expect(second).toMatchObject({
      ok: true,
      id: "20261102-090507-2",
      moved: [
        { from: "a.txt", to: ".swarm/archive/20261102-090507-2/a.txt" },
        { from: "d", to: ".swarm/archive/20261102-090507-2/d" },
      ],
    })
    expect(await fs.readFile(path.join(dir.path, ".swarm/archive/20261102-090507-1/a.txt"), "utf8")).toBe("first")
    expect(await fs.readFile(path.join(dir.path, ".swarm/archive/20261102-090507-2/a.txt"), "utf8")).toBe("second")
    expect(await fs.readFile(path.join(dir.path, ".swarm/archive/20261102-090507-2/d/e/f.txt"), "utf8")).toBe("f")
  })

  test("a missing path is reported, a relative path follows cwd, and a failed record does not undo the move", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "pkg"))
    await fs.writeFile(path.join(dir.path, "pkg/tmp.log"), "l")

    const result = await Archive.move({
      directory: dir.path,
      cwd: "pkg",
      paths: ["tmp.log", "gone.txt"],
      record: () => Promise.reject(new Error("disk")),
      now: NOW,
    })

    expect(result).toMatchObject({
      ok: true,
      moved: [{ from: "pkg/tmp.log", to: `.swarm/archive/${ID}/pkg/tmp.log` }],
      missing: ["pkg/gone.txt"],
      recorded: false,
    })
    expect(await Archive.folder(dir.path)).toBe(path.join(dir.path, ".swarm/archive"))
  })

  test("only missing paths makes no entry", async () => {
    await using dir = await tmpdir()

    const result = await Archive.move({ directory: dir.path, paths: ["gone"], now: NOW })

    expect(result).toEqual({ ok: true, id: "", moved: [], missing: ["gone"], bytes: 0, recorded: true })
    expect(await exists(path.join(dir.path, ".swarm"))).toBe(false)
  })
})
