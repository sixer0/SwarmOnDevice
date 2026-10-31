// What edit, write and apply_patch do with paths once they run inside an agent session, and what apply_patch does when
// the file changes while its prompt waits.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import path from "node:path"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { SessionID, MessageID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { ReadTool } from "../../src/tool/read"
import { GrepTool } from "../../src/tool/grep"
import { GlobTool } from "../../src/tool/glob"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { WriteTool } from "../../src/tool/write"
import { Instruction } from "../../src/session/instruction"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([CrossSpawnSpawner.node, LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node, Instruction.node, Ripgrep.node]),
    ),
    testInstanceStoreLayer,
  ),
)

type Asked = { permission: string; patterns: readonly string[]; always: readonly string[]; metadata: Record<string, unknown>; harmless?: boolean }

const seed = (dir: string) => {
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
  git("init", "-q")
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, "data"), { recursive: true })
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".gitignore"), "data/\ndist/\n")
  fs.writeFileSync(path.join(dir, "src/a.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
  fs.writeFileSync(path.join(dir, "src/b.ts"), "keep\n")
  fs.writeFileSync(path.join(dir, "data/local.db"), "only copy\n")
  fs.writeFileSync(path.join(dir, "dist/out.js"), "built\n")
  const outside = `${dir}-outside`
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n")
  fs.symlinkSync(path.join(outside, "outside.txt"), path.join(dir, "linkfile"))
  fs.symlinkSync(outside, path.join(dir, "linkdir"))
  fs.symlinkSync(".git", path.join(dir, "innocent"))
  git("add", "src", ".gitignore")
  git("commit", "-qm", "init")
}

const context = (asked: Asked[], onAsk: (dir: string) => void, dir: string) => ({
  sessionID: SessionID.make("ses_filetrust"),
  messageID: MessageID.make("msg_filetrust"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  trust: { canUndo: true },
  ask: (req: Asked) =>
    Effect.sync(() => {
      asked.push(req)
      if (!req.harmless) onAsk(dir)
    }),
})

// Every prompt is recorded and let through, so a test can see both what was asked and what happened after it.
const runTool = (
  tool: "write" | "edit" | "patch" | "read" | "grep" | "glob",
  params: (dir: string) => object,
  options?: { prepare?: (dir: string) => void; onAsk?: (dir: string) => void; check?: (dir: string) => void },
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    seed(dir)
    options?.prepare?.(dir)
    const asked: Asked[] = []
    const ctx = context(asked, options?.onAsk ?? (() => {}), dir)
    const exit = yield* Effect.gen(function* () {
      if (tool === "write") return yield* (yield* (yield* WriteTool).init()).execute(params(dir) as never, ctx as never)
      if (tool === "edit") return yield* (yield* (yield* EditTool).init()).execute(params(dir) as never, ctx as never)
      if (tool === "read") return yield* (yield* (yield* ReadTool).init()).execute(params(dir) as never, ctx as never)
      if (tool === "grep") return yield* (yield* (yield* GrepTool).init()).execute(params(dir) as never, ctx as never)
      if (tool === "glob") return yield* (yield* (yield* GlobTool).init()).execute(params(dir) as never, ctx as never)
      return yield* (yield* (yield* ApplyPatchTool).init()).execute(params(dir) as never, ctx as never)
    }).pipe(provideInstance(dir), Effect.exit)
    const edits = asked.filter((item) => item.permission === "edit" || item.permission === "external_directory")
    options?.check?.(dir)
    return {
      dir,
      asked: edits,
      // The baseline allows these two by name, and what they read is judged in the prompts they raise as "read".
      prompted: asked.filter((item) => !item.harmless && item.permission !== "grep" && item.permission !== "glob"),
      output: Exit.isSuccess(exit) ? exit.value.output : undefined,
      error: Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined,
    }
  })

const write = (relative: string) => (dir: string) => ({ filePath: path.join(dir, relative), content: "PWNED\n" })

describe("files a person has to be asked about", () => {
  for (const relative of [
    ".GIT/hooks/pre-commit",
    ".Git/config",
    "SWARM.JSON",
    ".SWARM/command/y.md",
    ".GitHub/workflows/y.yml",
    ".HUSKY/pre-commit",
    ".ENV",
    ".NPMRC",
    ".ENVRC",
    "innocent/config",
    ".gitconfig",
    "AGENTS.md",
    "package.json",
    "Makefile",
    "sub/Makefile",
    ".bashrc",
    ".zshenv",
    ".vscode/tasks.json",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    "Dockerfile",
    "vite.config.ts",
    ".swarm/plugin/x.ts",
    ".\u017fwarm/command/y.md",
    "\u017fwarm.json",
  ]) {
    it.live(`write asks: ${relative}`, () =>
      runTool("write", write(relative)).pipe(Effect.map((run) => expect(run.prompted.length).toBeGreaterThan(0))),
    )
  }

  it.live("write asks through a link to a secret file", () =>
    runTool("write", write("notes.txt"), {
      prepare: (dir) => {
        fs.writeFileSync(path.join(dir, ".env"), "API_KEY=x\n")
        fs.symlinkSync(".env", path.join(dir, "notes.txt"))
      },
    }).pipe(Effect.map((run) => expect(run.prompted.length).toBeGreaterThan(0))),
  )

  it.live("an ordinary edit stays unprompted: Undo covers it", () =>
    runTool("write", write("src/new.ts")).pipe(
      Effect.map((run) => {
        expect(run.prompted).toEqual([])
        expect(run.asked.length).toBeGreaterThan(0)
      }),
    ),
  )
})

describe("edits with nobody asked are for ordinary source", () => {
  for (const relative of ["tui.json", "composer.json", "CONTEXT.md", ".gitignore", ".agents/skills/x/SKILL.md", "scripts/x.sh", "tsconfig.json", "data.json", "src/tui.json"]) {
    it.live(`write asks: ${relative}`, () =>
      runTool("write", write(relative)).pipe(Effect.map((run) => expect(run.prompted.map((item) => item.permission)).toEqual(["edit"]))),
    )
  }
  for (const relative of ["src/new.ts", "README.md", "src/i18n/en.json"]) {
    it.live(`write does not: ${relative}`, () =>
      runTool("write", write(relative)).pipe(Effect.map((run) => expect(run.prompted).toEqual([]))),
    )
  }
  it.live("through a link to a config file counts as the config file", () =>
    runTool("write", write("src/notes.ts"), {
      prepare: (dir) => {
        fs.writeFileSync(path.join(dir, "tui.json"), "{}\n")
        fs.symlinkSync(path.join(dir, "tui.json"), path.join(dir, "src/notes.ts"))
      },
    }).pipe(Effect.map((run) => expect(run.prompted.map((item) => item.permission)).toEqual(["edit"]))),
  )
  it.live("a project that is itself a global config directory is not ordinary", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => process.env.SWARM_CONFIG_DIR),
      () =>
        runTool("write", write("src/plugin/x.ts"), {
          prepare: (dir) => {
            process.env.SWARM_CONFIG_DIR = dir
          },
        }).pipe(Effect.map((run) => expect(run.prompted.map((item) => item.permission)).toEqual(["edit"]))),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.SWARM_CONFIG_DIR
          else process.env.SWARM_CONFIG_DIR = previous
        }),
    ),
  )
  it.live("a hostile fsmonitor does not run when an edit asks whether Undo can help", () =>
    runTool("write", write("src/new2.ts"), {
      prepare: (dir) => {
        fs.writeFileSync(`${dir}-fsm`, `#!/bin/sh\necho ran > "${dir}-fired"\n`, { mode: 0o755 })
        spawnSync("git", ["config", "core.fsmonitor", `${dir}-fsm`], { cwd: dir })
        fs.mkdirSync(path.join(dir, ".git/hooks"), { recursive: true })
        fs.copyFileSync(`${dir}-fsm`, path.join(dir, ".git/hooks/post-index-change"))
      },
      check: (dir) => expect(fs.existsSync(`${dir}-fired`)).toBe(false),
    }),
  )
})

describe("read, grep and glob", () => {
  const reading = (tool: "read" | "grep" | "glob", params: (dir: string) => object, prepare?: (dir: string) => void) =>
    runTool(tool, params, { prepare })
  const secrets = (dir: string) => {
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
    fs.mkdirSync(path.join(dir, ".envs"))
    fs.writeFileSync(path.join(dir, ".envs/prod"), "API_KEY=abcSECRETvalue123456\n")
    fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "notes"))
    fs.mkdirSync(path.join(dir, ".kube"))
    fs.writeFileSync(path.join(dir, ".kube/config"), "password: abcSECRETvalue123456\n")
  }
  it.live("reading an ordinary file asks nothing of anyone", () =>
    reading("read", (dir) => ({ filePath: path.join(dir, "src/a.ts") })).pipe(Effect.map((run) => expect(run.prompted).toEqual([]))),
  )
  it.live("listing a directory asks nothing", () =>
    reading("read", (dir) => ({ filePath: path.join(dir, "src") })).pipe(Effect.map((run) => expect(run.prompted).toEqual([]))),
  )
  for (const relative of [".env", "notes", ".envs/prod", ".git/config", ".kube/config", "innocent/config"]) {
    it.live(`read asks: ${relative}`, () =>
      reading("read", (dir) => ({ filePath: path.join(dir, relative) }), secrets).pipe(
        Effect.map((run) => {
          expect(run.prompted[0]?.permission).toBe("read")
          expect(run.prompted[0]?.always).toEqual([])
        }),
      ),
    )
  }
  it.live("what a yes shows is still masked", () =>
    reading("read", (dir) => ({ filePath: path.join(dir, ".env") }), secrets).pipe(
      Effect.map((run) => expect(run.output).not.toContain("abcSECRETvalue123456")),
    ),
  )
  it.live("grep over the project leaves a secret file out of its answer, so a count is no oracle", () =>
    reading("grep", () => ({ pattern: "^API_KEY=abcS" }), (dir) => {
      secrets(dir)
      fs.writeFileSync(path.join(dir, "src/ok.ts"), "API_KEY=abcSok\n")
    }).pipe(
      Effect.map((run) => {
        expect(run.prompted).toEqual([])
        expect(run.output).toContain("ok.ts")
        expect(run.output).not.toContain(".env")
        expect(run.output).not.toContain("abcSECRET")
      }),
    ),
  )
  it.live("an include pattern naming one does not bring it back", () =>
    reading("grep", () => ({ pattern: "API_KEY", include: ".env" }), secrets).pipe(
      Effect.map((run) => expect(run.output).toBe("No files found")),
    ),
  )
  for (const relative of [".env", "notes", ".envs", ".git"]) {
    it.live(`grep asks: ${relative}`, () =>
      reading("grep", (dir) => ({ pattern: "x", path: path.join(dir, relative) }), secrets).pipe(
        Effect.map((run) => expect(run.prompted.map((item) => item.permission)).toEqual(["read"])),
      ),
    )
  }
  for (const relative of [".envs", ".git", ".kube"]) {
    it.live(`glob asks: ${relative}`, () =>
      reading("glob", (dir) => ({ pattern: "*", path: path.join(dir, relative) }), secrets).pipe(
        Effect.map((run) => expect(run.prompted.map((item) => item.permission)).toContain("read")),
      ),
    )
  }
  it.live("grep and glob outside the project ask", () =>
    Effect.gen(function* () {
      const grep = yield* reading("grep", (dir) => ({ pattern: "x", path: `${dir}-outside` }))
      expect(grep.prompted.map((item) => item.permission)).toContain("external_directory")
      const glob = yield* reading("glob", (dir) => ({ pattern: "*", path: `${dir}-outside` }))
      expect(glob.prompted.map((item) => item.permission)).toContain("external_directory")
      const link = yield* reading("grep", (dir) => ({ pattern: "x", path: path.join(dir, "linkdir") }))
      expect(link.prompted.map((item) => item.permission)).toContain("external_directory")
    }),
  )
})

describe("a symlink that leaves the project", () => {
  it.live("write asks about where it lands", () =>
    runTool("write", write("linkfile")).pipe(
      Effect.map((run) => {
        expect(run.prompted[0]?.permission).toBe("external_directory")
        expect(run.prompted[0]?.patterns[0]).toContain("-outside")
      }),
    ),
  )

  it.live("write asks for a file behind a linked directory", () =>
    runTool("write", write("linkdir/new.txt")).pipe(
      Effect.map((run) => expect(run.prompted[0]?.permission).toBe("external_directory")),
    ),
  )

  it.live("edit asks", () =>
    runTool("edit", (dir) => ({ filePath: path.join(dir, "linkfile"), oldString: "outside", newString: "PWNED" })).pipe(
      Effect.map((run) => expect(run.prompted[0]?.permission).toBe("external_directory")),
    ),
  )

  it.live("apply_patch asks, for a move destination too", () =>
    runTool("patch", () => ({
      patchText: "*** Begin Patch\n*** Update File: src/b.ts\n*** Move to: linkdir/moved.ts\n@@\n-keep\n+kept\n*** End Patch",
    })).pipe(Effect.map((run) => expect(run.prompted[0]?.permission).toBe("external_directory"))),
  )

  it.live("read asks", () =>
    runTool("read", (dir) => ({ filePath: path.join(dir, "linkfile") })).pipe(
      Effect.map((run) => expect(run.prompted[0]?.permission).toBe("external_directory")),
    ),
  )

  it.live("read hides a secret file behind an innocent name", () =>
    runTool("read", (dir) => ({ filePath: path.join(dir, "notes.txt") }), {
      prepare: (dir) => {
        fs.writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
        fs.symlinkSync(".env", path.join(dir, "notes.txt"))
      },
    }).pipe(Effect.map((run) => expect(run.output).not.toContain("abcSECRETvalue123456"))),
  )
})

describe("a gitignored file Undo cannot restore", () => {
  const cannotUndo = (run: { prompted: Asked[] }) => {
    expect(run.prompted[0]?.metadata.risk).toBe("irreversible")
    expect(run.prompted[0]?.always).toEqual([])
  }

  it.live("write asks and says why", () => runTool("write", write("data/local.db")).pipe(Effect.map(cannotUndo)))
  it.live("write asks about a new file there too", () => runTool("write", write("data/new.db")).pipe(Effect.map(cannotUndo)))
  it.live("edit asks and says why", () =>
    runTool("edit", (dir) => ({ filePath: path.join(dir, "data/local.db"), oldString: "only copy", newString: "gone" })).pipe(
      Effect.map(cannotUndo),
    ),
  )
  it.live("apply_patch asks and says why", () =>
    runTool("patch", () => ({
      patchText: "*** Begin Patch\n*** Update File: data/local.db\n@@\n-only copy\n+gone\n*** End Patch",
    })).pipe(Effect.map(cannotUndo)),
  )
  it.live("a rebuilt directory costs a rebuild, so it does not ask", () =>
    runTool("write", write("dist/out.js")).pipe(Effect.map((run) => expect(run.prompted).toEqual([]))),
  )
})

describe("an edit through a link", () => {
  it.live("to an ignored file asks and says Undo cannot help", () =>
    runTool("write", write("notes"), {
      prepare: (dir) => fs.symlinkSync("data/local.db", path.join(dir, "notes")),
    }).pipe(
      Effect.map((run) => {
        expect(run.prompted[0]?.metadata.risk).toBe("irreversible")
        expect(run.prompted[0]?.always).toEqual([])
      }),
    ),
  )
})

describe("apply_patch naming one file twice", () => {
  const patch = (dir: string, move: string) => ({
    patchText: `*** Begin Patch\n*** Update File: ${path.join(dir, "m.txt")}\n*** Move to: ${path.join(dir, move)}\n@@\n-x\n+y\n*** End Patch`,
  })
  const file = (dir: string) => fs.writeFileSync(path.join(dir, "m.txt"), "x\n")
  const finish = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    run.pipe(
      Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die(new Error("deadlocked on its own lock")) }),
    )

  it.live("two sections for one file are refused, with nothing written", () =>
    runTool("patch", (dir) => ({
      patchText: `*** Begin Patch\n*** Update File: ${path.join(dir, "m.txt")}\n@@\n-x\n+y\n*** Update File: ${path.join(dir, "m.txt")}\n@@\n-z\n+w\n*** End Patch`,
    }), { prepare: (dir) => fs.writeFileSync(path.join(dir, "m.txt"), "x\nz\n") }).pipe(
      Effect.map((run) => {
        expect(run.error).toContain("more than one section")
        expect(fs.readFileSync(path.join(run.dir, "m.txt"), "utf8")).toBe("x\nz\n")
      }),
    ),
  )
  it.live("delete then update of one file is refused too", () =>
    runTool("patch", (dir) => ({
      patchText: `*** Begin Patch\n*** Delete File: ${path.join(dir, "m.txt")}\n*** Update File: ${path.join(dir, "m.txt")}\n@@\n-x\n+y\n*** End Patch`,
    }), { prepare: (dir) => fs.writeFileSync(path.join(dir, "m.txt"), "x\n") }).pipe(
      Effect.map((run) => expect(run.error).toContain("more than one section")),
    ),
  )
  it.live("a move that only changes case does not wait on itself, and the file survives", () =>
    finish(runTool("patch", (dir) => patch(dir, "M.txt"), { prepare: file })).pipe(
      Effect.map((run) => {
        expect(run.error).toBeUndefined()
        expect(fs.readFileSync(path.join(run.dir, "m.txt"), "utf8")).toBe("y\n")
      }),
    ),
  )

  it.live("a move onto itself keeps the file", () =>
    finish(runTool("patch", (dir) => patch(dir, "m.txt"), { prepare: file })).pipe(
      Effect.map((run) => expect(fs.readFileSync(path.join(run.dir, "m.txt"), "utf8")).toBe("y\n")),
    ),
  )
})

describe("apply_patch while something else changes the files", () => {
  const change = (relative: string, text: string) => (dir: string) => fs.writeFileSync(path.join(dir, relative), text)
  // Ignored, so it asks, so there is a window in which the file can change.
  const ignored = (dir: string) => {
    fs.writeFileSync(path.join(dir, "data/a.txt"), "ONE\nkeep\n")
    fs.writeFileSync(path.join(dir, "data/b.txt"), "two\n")
  }

  it.live("delete refuses when the file changed during the prompt", () =>
    runTool("patch", () => ({ patchText: "*** Begin Patch\n*** Delete File: data/a.txt\n*** End Patch" }), {
      prepare: ignored,
      onAsk: change("data/a.txt", "someone-else\n"),
    }).pipe(
      Effect.map((run) => {
        expect(run.error).toContain("changed while this patch waited")
        expect(fs.readFileSync(path.join(run.dir, "data/a.txt"), "utf8")).toBe("someone-else\n")
      }),
    ),
  )

  it.live("move keeps a line someone else added", () =>
    runTool(
      "patch",
      () => ({ patchText: "*** Begin Patch\n*** Update File: data/a.txt\n*** Move to: data/c.txt\n@@\n-ONE\n+one\n*** End Patch" }),
      { prepare: ignored, onAsk: change("data/a.txt", "ONE\nkeep\nother-agent\n") },
    ).pipe(
      Effect.map((run) => {
        expect(fs.readFileSync(path.join(run.dir, "data/c.txt"), "utf8")).toBe("one\nkeep\nother-agent\n")
        expect(fs.existsSync(path.join(run.dir, "data/a.txt"))).toBe(false)
      }),
    ),
  )

  it.live("move refuses when its destination appeared during the prompt", () =>
    runTool(
      "patch",
      () => ({ patchText: "*** Begin Patch\n*** Update File: data/a.txt\n*** Move to: data/c.txt\n@@\n-ONE\n+one\n*** End Patch" }),
      { prepare: ignored, onAsk: change("data/c.txt", "other-agent\n") },
    ).pipe(
      Effect.map((run) => {
        expect(run.error).toContain("changed while this patch waited")
        expect(fs.readFileSync(path.join(run.dir, "data/c.txt"), "utf8")).toBe("other-agent\n")
        expect(fs.existsSync(path.join(run.dir, "data/a.txt"))).toBe(true)
      }),
    ),
  )

  it.live("add refuses when another agent created the file during the prompt", () =>
    runTool("patch", () => ({ patchText: "*** Begin Patch\n*** Add File: data/n.txt\n+mine\n*** End Patch" }), {
      onAsk: change("data/n.txt", "theirs\n"),
    }).pipe(
      Effect.map((run) => {
        expect(run.error).toContain("changed while this patch waited")
        expect(fs.readFileSync(path.join(run.dir, "data/n.txt"), "utf8")).toBe("theirs\n")
      }),
    ),
  )

  it.live("a refused file leaves the rest of the patch unwritten", () =>
    runTool(
      "patch",
      () => ({
        patchText: "*** Begin Patch\n*** Update File: data/a.txt\n@@\n-ONE\n+one\n*** Update File: data/b.txt\n@@\n-two\n+TWO\n*** End Patch",
      }),
      { prepare: ignored, onAsk: change("data/b.txt", "someone-else\n") },
    ).pipe(
      Effect.map((run) => {
        expect(run.error).toContain("Nothing was written")
        expect(fs.readFileSync(path.join(run.dir, "data/a.txt"), "utf8")).toBe("ONE\nkeep\n")
      }),
    ),
  )
})
