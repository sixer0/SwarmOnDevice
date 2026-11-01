import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Commit and apply from the changes panel, through the real routes, against repositories that name real programs. A marker file
// exists only if the repository's own program ran. Every "does not run" case has a trusted twin showing the same marker firing,
// so a quiet result means the program was held and not that the fixture was dead.

const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction", "post-index-change"]

const program = async (file: string, marker: string, body = "cat >/dev/null 2>&1 || true") => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n${body}\n`)
  await fs.chmod(file, 0o755)
}

const fired = async (dir: string) =>
  (await fs.readdir(path.join(dir, ".markers")).catch(() => [] as string[])).toSorted()
const mark = (dir: string, name: string) => path.join(dir, ".markers", name)

async function repo(init: (dir: string) => Promise<void>) {
  const tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await fs.mkdir(path.join(dir, ".markers"))
      await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n")
    },
  })
  await Bun.write(path.join(tmp.path, "a.txt"), "one\n")
  await $`git add a.txt`.cwd(tmp.path).quiet()
  await $`git commit -m base`.cwd(tmp.path).quiet()
  await init(tmp.path)
  await Bun.write(path.join(tmp.path, "a.txt"), "two\n")
  return tmp
}

const post = (dir: string, route: string, body: unknown) =>
  Server.Default().app.request(route, {
    method: "POST",
    headers: { "x-opencode-directory": dir, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const commit = (dir: string, files = ["a.txt"]) => post(dir, "/vcs/commit", { files, message: "Land it" })
const headFile = (dir: string, file: string) => $`git show HEAD:${file}`.cwd(dir).quiet().text()
const config = (dir: string, ...args: string[]) => $`git config ${args}`.cwd(dir).quiet()

const filtered = async (dir: string, name = "evil") => {
  await program(path.join(dir, ".prog/clean"), mark(dir, "filter-clean"), "tr a-z A-Z")
  await program(path.join(dir, ".prog/smudge"), mark(dir, "filter-smudge"), "cat")
  await program(path.join(dir, ".prog/process"), mark(dir, "filter-process"))
  await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n.prog\n")
  await Bun.write(path.join(dir, ".gitattributes"), `*.txt filter=${name}\n`)
  await config(dir, `filter.${name}.clean`, path.join(dir, ".prog/clean"))
  await config(dir, `filter.${name}.smudge`, path.join(dir, ".prog/smudge"))
}

beforeEach(() => ProjectTrust.assumeTrustedForTests(false))
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
afterAll(() => ProjectTrust.assumeTrustedForTests(true))

describe("POST /vcs/commit in an untrusted folder", () => {
  const hooked = async (dir: string) => {
    await Promise.all(HOOKS.map((hook) => program(path.join(dir, ".git/hooks", hook), mark(dir, hook))))
  }

  test("no hook runs, the commit lands, and the result says so", async () => {
    await using tmp = await repo(hooked)
    const response = await commit(tmp.path)
    expect(response.status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
    const body = await response.json()
    expect(body.files).toEqual(["a.txt"])
    expect(body.note).toContain("hooks")
    expect(body.note).toContain("swarm trust")
    expect(await headFile(tmp.path, "a.txt")).toBe("two\n")
  })

  test("trusted, the same hooks run and there is nothing to say", async () => {
    await using tmp = await repo(hooked)
    ProjectTrust.trust(tmp.path)
    const response = await commit(tmp.path)
    expect(response.status).toBe(200)
    expect(await fired(tmp.path)).toEqual(expect.arrayContaining(["pre-commit", "commit-msg", "post-commit"]))
    expect((await response.json()).note).toBeUndefined()
    ProjectTrust.revoke(tmp.path)
  })

  test("a refusing hook cannot refuse: it does not run", async () => {
    await using tmp = await repo(async (dir) => {
      await program(path.join(dir, ".git/hooks/pre-commit"), mark(dir, "pre-commit"), "exit 1")
    })
    expect((await commit(tmp.path)).status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
  })

  test("hooks at a path the repository's config names do not run", async () => {
    await using tmp = await repo(async (dir) => {
      await program(path.join(dir, ".evil-hooks/pre-commit"), mark(dir, "named-hook"))
      await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n.evil-hooks\n")
      await config(dir, "core.hooksPath", ".evil-hooks")
    })
    expect((await commit(tmp.path)).status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
  })

  test("a clean filter the config names does not run, and the bytes on disk are what lands", async () => {
    await using tmp = await repo(filtered)
    expect(ProjectTrust.status(tmp.path).state).toBe("ask")
    const response = await commit(tmp.path)
    expect(response.status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
    const body = await response.json()
    expect(body.files).toEqual(["a.txt"])
    expect(body.note).toContain("filters")
    expect(await $`git cat-file -p HEAD:a.txt`.cwd(tmp.path).quiet().text()).toBe("two\n")
  })

  test("trusted, the same filter runs", async () => {
    await using tmp = await repo(filtered)
    ProjectTrust.trust(tmp.path)
    expect((await commit(tmp.path)).status).toBe(200)
    expect(await fired(tmp.path)).toContain("filter-clean")
    ProjectTrust.revoke(tmp.path)
  })

  test("a new file still commits in a folder whose config names a program", async () => {
    await using tmp = await repo(filtered)
    await Bun.write(path.join(tmp.path, "new.txt"), "fresh\n")
    const response = await commit(tmp.path, ["new.txt"])
    expect(response.status).toBe(200)
    expect((await response.json()).files).toEqual(["new.txt"])
    expect(await fired(tmp.path)).toEqual([])
  })

  test("a filter that insists on running, a long-running one, and one with an awkward name all stay off", async () => {
    await using tmp = await repo(async (dir) => {
      await filtered(dir, "a=b.c")
      await config(dir, "filter.a=b.c.required", "true")
      await config(dir, "filter.a=b.c.process", path.join(dir, ".prog/process"))
    })
    const response = await commit(tmp.path)
    expect(response.status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
  })

  test("a filter brought in through include.path stays off", async () => {
    await using tmp = await repo(async (dir) => {
      await program(path.join(dir, ".prog/clean"), mark(dir, "included-clean"), "cat")
      await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n.prog\n")
      await Bun.write(path.join(dir, ".gitattributes"), "*.txt filter=inc\n")
      await Bun.write(path.join(dir, ".git/extra.cfg"), `[filter "inc"]\n\tclean = ${path.join(dir, ".prog/clean")}\n`)
      await config(dir, "include.path", "extra.cfg")
    })
    expect((await commit(tmp.path)).status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
  })

  test("a signing program the config names does not run, and the commit is unsigned", async () => {
    await using tmp = await repo(async (dir) => {
      await program(path.join(dir, ".prog/gpg"), mark(dir, "gpg"), "exit 1")
      await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n.prog\n")
      await config(dir, "commit.gpgsign", "true")
      await config(dir, "gpg.program", path.join(dir, ".prog/gpg"))
    })
    const response = await commit(tmp.path)
    expect(response.status).toBe(200)
    expect(await fired(tmp.path)).toEqual([])
    expect((await response.json()).note).toContain("signing")
  })

  test("the user's own global filter keeps working in an untrusted folder", async () => {
    await using tmp = await repo(async (dir) => {
      await program(path.join(dir, ".prog/mine"), mark(dir, "user-filter"), "cat")
      await Bun.write(path.join(dir, ".git/info/exclude"), ".markers\n.prog\n")
      await Bun.write(path.join(dir, ".gitattributes"), "*.txt filter=mine\n")
    })
    const global = path.join(tmp.path, ".git/user-global.cfg")
    await Bun.write(global, `[filter "mine"]\n\tclean = ${path.join(tmp.path, ".prog/mine")}\n`)
    process.env.GIT_CONFIG_GLOBAL = global
    try {
      expect((await commit(tmp.path)).status).toBe(200)
      expect(await fired(tmp.path)).toEqual(["user-filter"])
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL
    }
  })

  test("a refused commit still reports why and leaves a new file unstaged", async () => {
    await using tmp = await repo(hooked)
    await Bun.write(path.join(tmp.path, "new.txt"), "fresh\n")
    const response = await commit(tmp.path, ["new.txt", "missing.txt"])
    expect(response.status).not.toBe(200)
    expect(await $`git diff --cached --name-only`.cwd(tmp.path).quiet().text()).toBe("")
    expect(await fired(tmp.path)).toEqual([])
  })
})

describe("POST /vcs/apply in an untrusted folder", () => {
  const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n"

  test("no filter runs and the patch still lands", async () => {
    await using tmp = await repo(filtered)
    const response = await post(tmp.path, "/vcs/apply", { patch })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: true })
    expect(await fired(tmp.path)).toEqual([])
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("three\n")
  })

  test("trusted, the same filter runs", async () => {
    await using tmp = await repo(filtered)
    ProjectTrust.trust(tmp.path)
    await post(tmp.path, "/vcs/apply", { patch })
    expect(await fired(tmp.path)).toContain("filter-clean")
    ProjectTrust.revoke(tmp.path)
  })
})
