// What autonomous mode counts as a known destination (U11 rule 3, U13): the picture taken before the mode came on, no
// token kept, a remote added afterwards never matching, and the URL checked again right before it is used.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OutwardKnown } from "../../src/permission/outward-known"
import type { InstanceContext } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"

const git = (dir: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
}

const GH_STATUS = (login: string) => `github.com
  ✓ Logged in to github.com account ${login} (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account other-person (keyring)
  - Active account: false
  - Token: gho_************************************
`

/** Real git; `gh` and `rclone` answer from the test so nothing outside is asked. */
const runner = (gh: { text: string }) => {
  const real = OutwardKnown.defaultRun
  return (async (cmd: string[], cwd?: string) => {
    if (cmd[0] === "gh") return { code: 0, text: gh.text }
    if (cmd[0] === "rclone") return { code: 0, text: "nas:\ngdrive:\n" }
    return real(cmd, cwd)
  }) as OutwardKnown.Run
}

describe("permission.outward-known", () => {
  test("takes remotes of the project and nested repos, without the user part of a URL", async () => {
    await using dir = await tmpdir({ git: true })
    git(dir.path, "remote", "add", "origin", "https://x-access-token:SECRET123@github.com/acme/app.git")
    const nested = path.join(dir.path, "libs", "core")
    await fs.mkdir(nested, { recursive: true })
    git(nested, "init", "-q")
    git(nested, "remote", "add", "upstream", "git@github.com:acme/core.git")
    await fs.mkdir(path.join(dir.path, "node_modules", "dep"), { recursive: true })
    git(path.join(dir.path, "node_modules", "dep"), "init", "-q")

    const snap = await OutwardKnown.snapshot({ dir: dir.path, run: runner({ text: GH_STATUS("me") }), driveRoots: [] })
    const top = await fs.realpath(dir.path)
    expect(snap.repos.map((repo) => repo.dir).sort()).toEqual([top, await fs.realpath(nested)].sort())
    expect(snap.repos.find((repo) => repo.dir === top)?.remotes).toEqual([
      { name: "origin", push: ["https://github.com/acme/app.git"] },
    ])
    expect(snap.accounts).toEqual([{ host: "github.com", login: "me" }])
    expect(snap.rclone).toEqual(["nas", "gdrive"])
    // Nothing that looks like a token is kept, in the snapshot or in what the audit gets.
    const kept = JSON.stringify(snap) + JSON.stringify(OutwardKnown.summary(snap))
    expect(kept).not.toContain("SECRET123")
    expect(kept).not.toContain("gho_")
    expect(kept).not.toContain("Token")
  })

  test("reads only host and login from gh, active account first, older output too", () => {
    expect(OutwardKnown.accountsFrom(GH_STATUS("me"))).toEqual([{ host: "github.com", login: "me" }])
    expect(OutwardKnown.accountsFrom("github.com\n  ✓ Logged in to github.com as old (oauth_token)\n")).toEqual([
      { host: "github.com", login: "old" },
    ])
    expect(OutwardKnown.accountsFrom("github.com\n  X Failed to log in to github.com account me (keyring)\n")).toEqual(
      [],
    )
    expect(OutwardKnown.accountsFrom("")).toEqual([])
  })

  test("a named remote is known, a remote added after the snapshot does not match", async () => {
    await using dir = await tmpdir({ git: true })
    git(dir.path, "remote", "add", "origin", "https://github.com/acme/app.git")
    const gh = { text: GH_STATUS("me") }
    const run = runner(gh)
    const snap = await OutwardKnown.snapshot({ dir: dir.path, run, driveRoots: [] })
    const top = await fs.realpath(dir.path)

    const named = OutwardKnown.named(snap, "Fix the bug, then git push origin main.")
    expect(named).toContainEqual(
      expect.objectContaining({ kind: "git", remote: "origin", host: "github.com", path: "acme/app" }),
    )
    expect(OutwardKnown.named(snap, "Fix the bug.").filter((item) => item.kind === "git")).toEqual([])

    git(dir.path, "remote", "add", "evil", "https://github.com/someone-else/app.git")
    expect(OutwardKnown.named(snap, "push to evil").filter((item) => item.kind === "git")).toEqual([])
    expect(OutwardKnown.pushTarget(snap, top, "evil")).toBeUndefined()
    expect(OutwardKnown.pushTarget(snap, top, "https://github.com/someone-else/app.git")).toBeUndefined()
    expect(OutwardKnown.pushTarget(snap, top, "https://github.com/acme/app")?.name).toBe("origin")
    expect(await OutwardKnown.recheck(snap, dir.path, "evil", run)).toEqual({ ok: false, reason: "remote_new" })
    expect((await OutwardKnown.recheck(snap, dir.path, "origin", run)).ok).toBe(true)
  })

  test("the URL and the account are checked again when the remote is used", async () => {
    await using dir = await tmpdir({ git: true })
    git(dir.path, "remote", "add", "origin", "https://github.com/acme/app.git")
    const gh = { text: GH_STATUS("me") }
    const run = runner(gh)
    const snap = await OutwardKnown.snapshot({ dir: dir.path, run, driveRoots: [] })

    git(dir.path, "remote", "set-url", "--push", "origin", "https://github.com/someone-else/app.git")
    expect(await OutwardKnown.recheck(snap, dir.path, "origin", run)).toEqual({ ok: false, reason: "url_changed" })
    git(dir.path, "config", "--unset", "remote.origin.pushurl")
    expect((await OutwardKnown.recheck(snap, dir.path, "origin", run)).ok).toBe(true)

    // `insteadOf` written after the snapshot sends the same name elsewhere: it no longer matches.
    git(dir.path, "config", "url.https://evil.example/.pushInsteadOf", "https://github.com/")
    expect(await OutwardKnown.recheck(snap, dir.path, "origin", run)).toEqual({ ok: false, reason: "url_changed" })
    git(dir.path, "config", "--remove-section", "url.https://evil.example/")

    gh.text = GH_STATUS("someone")
    expect(await OutwardKnown.recheck(snap, dir.path, "origin", run)).toEqual({ ok: false, reason: "account_changed" })
  })

  test("a host nobody is logged in to is not a known push", async () => {
    await using dir = await tmpdir({ git: true })
    git(dir.path, "remote", "add", "origin", "git@gitlab.example:acme/app.git")
    const run = runner({ text: "" })
    const snap = await OutwardKnown.snapshot({ dir: dir.path, run, driveRoots: [] })
    expect(await OutwardKnown.recheck(snap, dir.path, "origin", run)).toEqual({ ok: false, reason: "no_credential" })
  })

  test("rclone remotes, drives and hosts the person named", async () => {
    await using root = await tmpdir()
    await fs.mkdir(path.join(root.path, "NAS"))
    await fs.mkdir(path.join(root.path, "GoogleDrive-me@example.com"))
    await fs.mkdir(path.join(root.path, "Other"))
    await fs.symlink("/", path.join(root.path, "Macintosh HD"))
    await using dir = await tmpdir()
    const snap = await OutwardKnown.snapshot({ dir: dir.path, run: runner({ text: "" }), driveRoots: [root.path] })
    expect(snap.drives.map((drive) => path.basename(drive)).sort()).toEqual([
      "GoogleDrive-me@example.com",
      "NAS",
      "Other",
    ])

    const named = OutwardKnown.named(
      snap,
      "Copy the report to the NAS and to Google Drive, sync with rclone gdrive:, and read docs.example.com",
    )
    expect(named).toContainEqual({ kind: "rclone", name: "gdrive" })
    expect(named).not.toContainEqual({ kind: "rclone", name: "nas" })
    expect(
      named
        .filter((item) => item.kind === "drive")
        .map((item) => path.basename((item as { path: string }).path))
        .sort(),
    ).toEqual(["GoogleDrive-me@example.com", "NAS"])
    expect(named).toContainEqual({ kind: "host", host: "docs.example.com" })
    // A file name is not a host, and an email is not a machine without ssh, scp or rsync.
    const quiet = OutwardKnown.named(snap, "Edit index.ts and mail me@example.org")
    expect(quiet.filter((item) => item.kind === "host").map((item) => (item as { host: string }).host)).toEqual([])
    expect(quiet.filter((item) => item.kind === "ssh")).toEqual([])
    expect(OutwardKnown.named(snap, "rsync the build to deploy@box.example.com")).toContainEqual({
      kind: "ssh",
      user: "deploy",
      host: "box.example.com",
    })
  })

  test("a URL followed by punctuation still names its host, and a fetch there matches once ticked", () => {
    const snap: OutwardKnown.Snapshot = { at: 0, repos: [], accounts: [], rclone: [], drives: [] }
    for (const text of [
      "fetch https://docs.example.com, then summarise",
      "read https://docs.example.com/guide. Then stop",
      "see https://docs.example.com; and https://api.example.com:",
    ])
      expect([text, OutwardKnown.named(snap, text).some((item) => item.kind === "host" && item.host === "docs.example.com")]).toEqual([text, true])
    const allowed = OutwardKnown.named(snap, "fetch https://docs.example.com, then summarise").map((destination, index) => ({
      id: `destination:${index}`,
      destination,
    }))
    const url = "https://docs.example.com/guide"
    const verdict = AutonomyTable.classify({
      permission: "webfetch",
      patterns: [url],
      metadata: { url },
      instance: { directory: "/", worktree: "/", project: { vcs: "git" } } as InstanceContext,
      cwd: "/",
      canUndo: true,
      folder: "clean",
      outward: { allowed, snapshot: snap },
    })
    expect(verdict).toEqual({ class: "A", decidedBy: "gate", via: "outward", consentID: "destination:0", destination: "docs.example.com" })
  })

  test("the audit label hides account names", () => {
    expect(
      OutwardKnown.label({ kind: "git", repo: "/r", remote: "origin", url: "", host: "github.com", path: "acme/app" }),
    ).toBe("origin github.com/a***/app")
    expect(OutwardKnown.label({ kind: "drive", path: "/x/GoogleDrive-me@example.com" })).toBe("GoogleDrive-*")
    expect(OutwardKnown.label({ kind: "ssh", user: "deploy", host: "box.example.com" })).toBe("d****@box.example.com")
  })

  test("parses the URL forms git accepts and leaves local paths alone", () => {
    expect(OutwardKnown.parse("git@github.com:Acme/App.git")).toEqual({ host: "github.com", path: "acme/app" })
    expect(OutwardKnown.parse("ssh://git@github.com:22/acme/app.git")).toEqual({ host: "github.com", path: "acme/app" })
    expect(OutwardKnown.parse("https://github.com/acme/app/")).toEqual({ host: "github.com", path: "acme/app" })
    expect(OutwardKnown.parse("/srv/git/app.git")).toBeUndefined()
    expect(OutwardKnown.parse("../app")).toBeUndefined()
    expect(OutwardKnown.parse("C:\\repos\\app")).toBeUndefined()
    expect(OutwardKnown.stripUser("https://u:p@host/x")).toBe("https://host/x")
  })
})
