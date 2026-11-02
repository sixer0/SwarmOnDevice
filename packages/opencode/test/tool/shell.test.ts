import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { mkdir, stat, symlink } from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { AutonomyTable } from "@/permission/autonomy-table"
import { Shell } from "@opencode-ai/core/shell"
import { SCRIPT_CHANGED_TEXT, ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Autonomy } from "@/permission/autonomy"
import { Session } from "@/session/session"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "OPENCODE_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            directories: [outerTmp],
            patterns: [expected],
          })
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("asks for bash permission even when command is cd only, as text can look like a cd and be more", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq?.patterns).toEqual(["cd ."])
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(yield* fail({ command: "echo test > output.txt" }, capture(requests, err))).toMatchObject({
            message: err.message,
          })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

const CREDENTIALS = [
  "OPENCODE_SERVER_PASSWORD",
  "SWARM_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "SWARM_SERVER_USERNAME",
]

const withEnv = <A, E, R>(values: Record<string, string>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = Object.keys(values).map((name) => [name, process.env[name]] as const)
      Object.assign(process.env, values)
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() =>
        prev.forEach(([name, value]) => {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }),
      ),
  )

// Read from a file the command writes, because the tool's own output is filtered for secrets and would not show what it saw.
const seenEnv = Effect.fn("ShellToolTest.seenEnv")(function* (dir: string) {
  const file = path.join(dir, "seen-env.json")
  const text = `${bin} -e ${evalarg("Bun.write(Bun.argv[1],JSON.stringify(process.env))")} ${quote(file.replaceAll("\\", "/"))}`
  const result = yield* run({ command: PS.has(sh()) ? `& ${text}` : text })
  expect(result.metadata.exit).toBe(0)
  return yield* Effect.promise(() => Bun.file(file).json() as Promise<Record<string, string>>)
})

describe("tool.shell server credentials", () => {
  each("does not hand the server's credentials to a command", () =>
    withEnv(
      {
        ...Object.fromEntries(CREDENTIALS.map((name) => [name, `from-server-${name}`])),
        SHELL_TEST_KEPT: "still-here",
      },
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const env = yield* seenEnv(tmp)
            CREDENTIALS.forEach((name) => expect(env).not.toHaveProperty(name))
            expect(JSON.stringify(env)).not.toContain("from-server-")
            expect(env.SHELL_TEST_KEPT).toBe("still-here")
          }),
        )
      }),
    ),
  )

  // Windows finds a variable under any spelling of its name, so a differently cased copy would reach the command there.
  it.live("drops a differently cased copy too", () =>
    withEnv(
      { opencode_server_password: "from-server-lowercase" },
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const env = yield* seenEnv(tmp)
            expect(JSON.stringify(env)).not.toContain("from-server-")
            expect(env.PATH).toBeDefined()
          }),
        )
      }),
    ),
  )

  it.live("drops them after the shell.env plugin hook, and keeps what else it adds", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const plugin = path.join(tmp, "plugin.ts")
      yield* Effect.promise(() =>
        Bun.write(
          plugin,
          [
            "export default async () => ({",
            '  "shell.env": (input, output) => {',
            ...CREDENTIALS.map((name) => `    output.env.${name} = "from-plugin-${name}"`),
            '    output.env.SHELL_TEST_PLUGIN = "plugin-kept"',
            "  },",
            "})",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp, "swarm.json"),
          JSON.stringify({ plugin: [pathToFileURL(plugin).href], formatter: false, lsp: false }),
        ),
      )
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const env = yield* seenEnv(tmp)
          CREDENTIALS.forEach((name) => expect(env).not.toHaveProperty(name))
          expect(JSON.stringify(env)).not.toContain("from-plugin-")
          expect(env.SHELL_TEST_PLUGIN).toBe("plugin-kept")
        }),
      )
    }),
  )
})

describe("tool.shell prompt workdir", () => {
  each("both prompts name the folder a relative workdir resolves to", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outer, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      const sub = path.join(tmp, "sub")
      yield* Effect.promise(() => mkdir(sub))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: `cat ${path.join(outer, "outside.txt")}`, workdir: "sub" }, capture(requests))
          expect(requests.map((request) => request.permission)).toEqual(["external_directory", "bash"])
          requests.forEach((request) => expect(request.metadata.workdir).toBe(Filesystem.normalizePath(sub)))
        }),
      )
    }),
  )

  each("names the project folder when no workdir is given", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "echo hi" }, capture(requests))
          expect(requests.map((request) => request.metadata.workdir)).toEqual([tmp])
        }),
      )
    }),
  )

  each("names a workdir outside the project on both prompts", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "echo hi", workdir: outer }, capture(requests))
          expect(requests.map((request) => request.permission)).toEqual(["external_directory", "bash"])
          requests.forEach((request) => expect(request.metadata.workdir).toBe(outer))
        }),
      )
    }),
  )

  // `link` exists only in `sub`, and leaves the project. Judged from the project folder, the same words name a harmless
  // missing path inside it, which is the mistake this field is there to prevent.
  ;(process.platform === "win32" ? it.live.skip : it.live)("lets the table judge a relative path where it runs", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outer, "keep.txt"), "x"))
      const tmp = yield* tmpdirScoped({ git: true })
      const sub = path.join(tmp, "sub")
      yield* Effect.promise(() => mkdir(sub))
      yield* Effect.promise(() => symlink(outer, path.join(sub, "link")))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const next = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission === "bash") throw err
              }),
          }
          expect(yield* fail({ command: "rm link/keep.txt", workdir: "sub" }, next)).toMatchObject({
            message: err.message,
          })
          const request = requests.find((item) => item.permission === "bash")!
          const judge = (cwd: string) =>
            AutonomyTable.classify({
              permission: request.permission,
              patterns: request.patterns,
              metadata: request.metadata,
              instance,
              cwd,
              canUndo: true,
              folder: "clean",
            })
          expect(request.metadata.workdir).toBe(sub)
          expect(judge(request.metadata.workdir as string).class).toBe("D")
          // U11 rule 4: from the folder it is a plain deletion of a safe path. This shell is not in the mode, so it did not
          // say it moves it, and a deletion for good waits for a person.
          expect(judge(instance.directory)).toMatchObject({ class: "D", category: "not_reversible" })
          expect(yield* Effect.promise(() => Bun.file(path.join(outer, "keep.txt")).exists())).toBe(true)
        }),
      )
    }),
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `sleep 60`,
            timeout: 500,
          })
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("commands will time out after 500ms")
          const result = yield* tool.execute(
            {
              command: `sleep 60`,
            },
            ctx,
          )
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: `${fill("lines", lineCount)} | cat`,
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("long runs of similar lines are hidden from the model and kept in a file", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({ command: fill("lines", 500) })
        const metadata = result.metadata as { truncated?: boolean; outputPath?: string; output?: string }
        expect(metadata.truncated).toBe(false)
        expect(result.output).toContain("... 495 similar lines ...")
        expect(result.output).toContain("495 similar lines hidden. Full output saved to:")
        expect(result.output.length).toBeLessThan(400)
        expect(metadata.output?.trim().split(/\r?\n/).length).toBe(500)
        const saved = yield* (yield* FSUtil.Service).readFileString(metadata.outputPath!)
        expect(saved.trim().split(/\r?\n/).length).toBe(500)
      }),
    ),
  )

  it.live("a cut output keeps its start as well as its end", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({ command: `${fill("lines", Truncate.MAX_LINES + 500)} | cat` })
        mustTruncate(result)
        expect(result.output.startsWith("1\n2\n")).toBe(true)
        expect(result.output.trimEnd().endsWith(String(Truncate.MAX_LINES + 500))).toBe(true)
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: `${fill("lines", lineCount)} | cat`,
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})

// U11 rule 4 (row 151): with autonomous mode on, a deletion is moved to `.swarm/archive` instead of run.
describe("tool.shell archive in autonomous mode", () => {
  const archiveTool = (on: boolean, lines: unknown[]) =>
    ShellTool.pipe(
      Effect.flatMap((info) => info.init()),
      Effect.provideService(
        Autonomy.Service,
        Autonomy.Service.of({
          isOn: () => Effect.succeed(on),
          record: (_root: unknown, line: unknown) => Effect.sync(() => void lines.push(line)),
        } as unknown as Autonomy.Interface),
      ),
      Effect.provideService(
        Session.Service,
        Session.Service.of({
          get: () => Effect.fail(new Error("no session")),
        } as unknown as Session.Interface),
      ),
    )
  const exists = (file: string) => Effect.promise(() => stat(file).then(() => true, () => false))
  const seed = (dir: string, files: string[]) =>
    Effect.promise(async () => {
      for (const file of files) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
        await Bun.write(path.join(dir, file), "x")
      }
    })
  const archived = (dir: string) =>
    Effect.promise(async () => {
      const { readdir } = await import("fs/promises")
      return readdir(path.join(dir, ".swarm", "archive"), { recursive: true }).catch(() => [] as string[])
    })
  const posixOnly = process.platform === "win32" ? it.live.skip : it.live

  for (const [command, files, left] of [
    ["rm -rf build", ["build/out.js", "keep.txt"], "build/out.js"],
    ["rm a.txt", ["a.txt", "keep.txt"], "a.txt"],
    ["unlink a.txt", ["a.txt", "keep.txt"], "a.txt"],
    ["git rm -r -- src", ["src/a.ts", "keep.txt"], "src/a.ts"],
  ] as const) {
    posixOnly(`moves for ${command}`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped({ git: true })
        yield* seed(tmp, [...files])
        const lines: unknown[] = []
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const tool = yield* archiveTool(true, lines)
            const result = yield* tool.execute({ command }, ctx)
            const id = result.output.match(/\.swarm\/archive\/(\S+) instead/)?.[1]
            expect(result.output).toBe(
              `Swarm moved 1 path(s) to .swarm/archive/${id} instead of deleting them. The person empties the archive when they return.`,
            )
            expect(result.metadata.exit).toBe(0)
            expect(yield* exists(path.join(tmp, left))).toBe(false)
            expect(yield* exists(path.join(tmp, "keep.txt"))).toBe(true)
            expect(yield* exists(path.join(tmp, ".swarm", "archive", id!, left))).toBe(true)
            expect(lines).toHaveLength(1)
            expect(lines[0]).toMatchObject({ type: "outcome", outcome: "archived", archive: id })
          }),
        )
      }),
    )
  }

  posixOnly("rmdir moves an empty folder and refuses a full one as rmdir would", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => mkdir(path.join(tmp, "empty")))
      yield* seed(tmp, ["full/a.txt"])
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* archiveTool(true, [])
          expect((yield* tool.execute({ command: "rmdir empty" }, ctx)).output).toContain("Swarm moved 1 path(s)")
          const full = yield* tool.execute({ command: "rm full" }, ctx)
          expect(full.output).toBe("rm: full: is a directory")
          expect(yield* exists(path.join(tmp, "full", "a.txt"))).toBe(true)
        }),
      )
    }),
  )

  posixOnly("a deletion joined to another command does not run", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* seed(tmp, ["a.txt", "b.log"])
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* archiveTool(true, [])
          for (const command of ["rm a.txt && echo ran", "rm *.log", "echo x | xargs rm", "rm $FILE", "sudo rm a.txt"]) {
            const result = yield* tool.execute({ command }, ctx)
            expect(result.output).toBe(
              "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only), so Swarm can move the paths to the archive instead.",
            )
          }
          expect(yield* exists(path.join(tmp, "a.txt"))).toBe(true)
          expect(yield* exists(path.join(tmp, "b.log"))).toBe(true)
          expect(yield* archived(tmp)).toEqual([])
        }),
      )
    }),
  )

  posixOnly("the archive itself is not moved, and other commands run", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* seed(tmp, ["a.txt"])
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* archiveTool(true, [])
          yield* tool.execute({ command: "rm a.txt" }, ctx)
          const again = yield* tool.execute({ command: "rm -rf .swarm" }, ctx)
          expect(again.output).not.toContain("Swarm moved")
          expect((yield* archived(tmp)).length).toBeGreaterThan(0)
          expect((yield* tool.execute({ command: "echo hello" }, ctx)).output.trim()).toBe("hello")
          const cached = yield* tool.execute({ command: "git rm --cached nothing 2>/dev/null; echo ok" }, ctx)
          expect(cached.output).not.toContain("did not run")
        }),
      )
    }),
  )

  posixOnly("with the mode off the command deletes as usual", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* seed(tmp, ["a.txt"])
      const lines: unknown[] = []
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* archiveTool(false, lines)
          const result = yield* tool.execute({ command: "rm a.txt" }, ctx)
          expect(result.metadata.exit).toBe(0)
          expect(yield* exists(path.join(tmp, "a.txt"))).toBe(false)
          expect(yield* exists(path.join(tmp, ".swarm"))).toBe(false)
          expect(lines).toEqual([])
          // Without the services at all, as every other test here builds the tool.
          yield* seed(tmp, ["b.txt"])
          yield* run({ command: "rm b.txt" })
          expect(yield* exists(path.join(tmp, "b.txt"))).toBe(false)
        }),
      )
    }),
  )

  // Row 113: the table answers A `archived` only on the shell's word that it moves (`metadata.archive`). Here the gate is
  // the table itself: whatever it does not answer A stops the call before anything runs.
  const gated = (asked: Record<string, unknown>[]) =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      return {
        ...ctx,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.suspend(() => {
            asked.push(req.metadata)
            if (req.permission !== "bash") return Effect.void
            const verdict = AutonomyTable.classify({
              permission: req.permission,
              patterns: req.patterns,
              metadata: req.metadata,
              instance,
              cwd: String(req.metadata.workdir),
              canUndo: true,
              folder: "clean",
            })
            asked.push({ verdict })
            return verdict.class === "A" ? Effect.void : Effect.die(new Error(`held ${verdict.class} ${verdict.category}`))
          }),
      } as Tool.Context
    })

  posixOnly("a plain deletion the shell says it moves is A `archived`, and the file is in the archive", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* seed(tmp, ["build/out.js", "keep.txt"])
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const asked: Record<string, unknown>[] = []
          const tool = yield* archiveTool(true, [])
          const result = yield* tool.execute({ command: "rm -rf build" }, yield* gated(asked))
          expect(asked).toContainEqual(expect.objectContaining({ command: "rm -rf build", archive: true }))
          expect(asked).toContainEqual({ verdict: { class: "A", decidedBy: "gate", category: "archived" } })
          const id = result.output.match(/\.swarm\/archive\/(\S+) instead/)?.[1]
          expect(yield* exists(path.join(tmp, "build", "out.js"))).toBe(false)
          expect(yield* exists(path.join(tmp, ".swarm", "archive", id!, "build", "out.js"))).toBe(true)
        }),
      )
    }),
  )

  posixOnly("the same deletion with the mode off sends no word, is D `not_reversible`, and deletes nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* seed(tmp, ["build/out.js"])
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const asked: Record<string, unknown>[] = []
          const tool = yield* archiveTool(false, [])
          const exit = yield* tool.execute({ command: "rm -rf build" }, yield* gated(asked)).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(asked.some((item) => "archive" in item)).toBe(false)
          expect(asked).toContainEqual({ verdict: { class: "D", decidedBy: "gate", category: "not_reversible" } })
          expect(yield* exists(path.join(tmp, "build", "out.js"))).toBe(true)
          expect(yield* exists(path.join(tmp, ".swarm"))).toBe(false)
        }),
      )
    }),
  )

  posixOnly("under PowerShell the shell would run it, so it sends no word, it is D `not_reversible`, and nothing is deleted", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* seed(tmp, ["a.txt"])
      // A file named pwsh is read as PowerShell by its name; the gate stops the call before it would start.
      const pwsh = path.join(yield* tmpdirScoped(), "pwsh")
      yield* Effect.promise(() => symlink("/bin/sh", pwsh))
      yield* withShell(
        { label: "pwsh", shell: pwsh },
        runIn(
          tmp,
          Effect.gen(function* () {
            expect(Shell.ps(Shell.acceptable())).toBe(true)
            const asked: Record<string, unknown>[] = []
            const tool = yield* archiveTool(true, [])
            const exit = yield* tool.execute({ command: "rm a.txt" }, yield* gated(asked)).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(asked.some((item) => "archive" in item)).toBe(false)
            expect(asked).toContainEqual({ verdict: { class: "D", decidedBy: "gate", category: "not_reversible" } })
            expect(yield* exists(path.join(tmp, "a.txt"))).toBe(true)
            expect(yield* exists(path.join(tmp, ".swarm"))).toBe(false)
          }),
        ),
      )
    }),
  )

  // C97 F2: a plain `cp`/`mv` that would replace a file moves that file to the archive first, and says so to the gate.
  const write = (file: string, text: string) =>
    Effect.promise(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, text)
    })
  const text = (file: string) => Effect.promise(() => Bun.file(file).text())

  for (const [command, replaced] of [
    ["cp docs/a.md docs/b.md", "docs/b.md"],
    ["mv docs/a.md docs/b.md", "docs/b.md"],
    ['cp "docs/a.md" docs/old', "docs/old/a.md"],
  ] as const)
    posixOnly(`C97 F2: ${command} keeps the file it replaces in the archive, and the gate lets it through as archived`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* write(path.join(tmp, "docs/a.md"), "new\n")
        yield* write(path.join(tmp, replaced), "old\n")
        const lines: unknown[] = []
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const asked: Record<string, unknown>[] = []
            const tool = yield* archiveTool(true, lines)
            const result = yield* tool.execute({ command }, yield* gated(asked))
            expect(asked).toContainEqual(expect.objectContaining({ command, archiveTargets: [path.join(tmp, replaced)] }))
            expect(asked).toContainEqual({ verdict: { class: "A", decidedBy: "gate", category: "archived" } })
            expect(result.metadata.exit).toBe(0)
            const id = result.output.match(/\.swarm\/archive\/(\S+) instead/)?.[1]
            expect(id).toBeDefined()
            expect(yield* text(path.join(tmp, replaced))).toBe("new\n")
            expect(yield* text(path.join(tmp, ".swarm", "archive", id!, replaced))).toBe("old\n")
            expect(lines).toEqual([expect.objectContaining({ type: "outcome", outcome: "archived", archive: id })])
          }),
        )
      }),
    )

  posixOnly("C97 F2: a copy or move to a new name sends no word, is A `file-op`, and archives nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp, "docs/a.md"), "new\n")
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          for (const command of ["cp docs/a.md docs/c.md", "mv docs/c.md docs/d.md", "mkdir -p out/deep", "touch out/e.md"]) {
            const asked: Record<string, unknown>[] = []
            const result = yield* (yield* archiveTool(true, [])).execute({ command }, yield* gated(asked))
            expect([command, asked.some((item) => "archiveTargets" in item)]).toEqual([command, false])
            expect([command, asked.filter((item) => "verdict" in item)]).toEqual([command, [{ verdict: { class: "A", decidedBy: "gate", category: "file-op" } }]])
            expect(result.metadata.exit).toBe(0)
          }
          expect(yield* text(path.join(tmp, "docs/d.md"))).toBe("new\n")
          expect(yield* exists(path.join(tmp, "out/e.md"))).toBe(true)
          expect(yield* exists(path.join(tmp, ".swarm"))).toBe(false)
        }),
      )
    }),
  )

  posixOnly("C97 F2: with the mode off a replacing copy sends no word, is D `not_reversible`, and replaces nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp, "docs/a.md"), "new\n")
      yield* write(path.join(tmp, "docs/b.md"), "old\n")
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const asked: Record<string, unknown>[] = []
          const exit = yield* (yield* archiveTool(false, [])).execute({ command: "cp docs/a.md docs/b.md" }, yield* gated(asked)).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(asked.some((item) => "archiveTargets" in item)).toBe(false)
          expect(asked).toContainEqual({ verdict: { class: "D", decidedBy: "gate", category: "not_reversible" } })
          expect(yield* text(path.join(tmp, "docs/b.md"))).toBe("old\n")
        }),
      )
    }),
  )

  posixOnly("C97 F2: a source beyond the folder replacing a file is not let through, and neither file changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const away = yield* tmpdirScoped()
      yield* write(path.join(away, "n.md"), "away\n")
      yield* write(path.join(tmp, "docs/b.md"), "old\n")
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          for (const command of [`cp ${path.join(away, "n.md")} docs/b.md`, `mv ${path.join(away, "n.md")} docs/m.md`]) {
            const asked: Record<string, unknown>[] = []
            const exit = yield* (yield* archiveTool(true, [])).execute({ command }, yield* gated(asked)).pipe(Effect.exit)
            expect([command, Exit.isFailure(exit)]).toEqual([command, true])
            expect(asked.some((item) => "verdict" in item && (item.verdict as { class: string }).class === "A")).toBe(false)
          }
          expect(yield* text(path.join(tmp, "docs/b.md"))).toBe("old\n")
          expect(yield* text(path.join(away, "n.md"))).toBe("away\n")
          expect(yield* exists(path.join(tmp, "docs/m.md"))).toBe(false)
        }),
      )
    }),
  )
})

// U11 rule 6 (row 154): in autonomous mode a script is hashed before the gate judges it and again right before it runs.
describe("tool.shell script hash in autonomous mode", () => {
  const hashTool = (on: boolean, lines: unknown[]) =>
    ShellTool.pipe(
      Effect.flatMap((info) => info.init()),
      Effect.provideService(
        Autonomy.Service,
        Autonomy.Service.of({
          isOn: () => Effect.succeed(on),
          record: (_root: unknown, line: unknown) => Effect.sync(() => void lines.push(line)),
        } as unknown as Autonomy.Interface),
      ),
      Effect.provideService(
        Session.Service,
        Session.Service.of({
          get: () => Effect.fail(new Error("no session")),
        } as unknown as Session.Interface),
      ),
    )
  const exists = (file: string) =>
    Effect.promise(() =>
      stat(file).then(
        () => true,
        () => false,
      ),
    )
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
  const write = (file: string, text: string) =>
    Effect.promise(async () => {
      await Bun.write(file, text)
      const { chmod } = await import("fs/promises")
      await chmod(file, 0o755)
    })
  // The gate's answer is "allow"; `during` stands for whatever happens to the file while it is being judged.
  const judged = (
    requests: Array<{ permission: string; metadata: Record<string, unknown> }>,
    during = Effect.void,
  ) => ({
    ...ctx,
    ask: (req: { permission: string; metadata: Record<string, unknown> }) =>
      Effect.gen(function* () {
        requests.push(req)
        if (req.permission === "bash") yield* during
      }),
  })
  const posixOnly = process.platform === "win32" ? it.live.skip : it.live
  const CLEAN = "echo ran\n"
  const CHANGED = "touch changed.txt\necho ran\n"

  posixOnly("a script that did not change runs, and the request carries its hash", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp, "run.sh"), CLEAN)
      const lines: unknown[] = []
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* hashTool(true, lines)
          for (const command of ["bash run.sh", "./run.sh"]) {
            const requests: Array<{ permission: string; metadata: Record<string, unknown> }> = []
            const result = yield* tool.execute({ command }, judged(requests))
            expect(result.output.trim()).toBe("ran")
            expect(requests.find((item) => item.permission === "bash")?.metadata.scripts).toEqual([
              { file: path.join(tmp, "run.sh"), sha256: sha(CLEAN) },
            ])
          }
          expect(lines).toEqual([])
        }),
      )
    }),
  )

  posixOnly("a script that changed after it was judged does not run", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp, "run.sh")
      const lines: unknown[] = []
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* hashTool(true, lines)
          for (const command of ["bash run.sh", "./run.sh", "nohup python3 -u run.sh", "env A=1 sh ./run.sh x"]) {
            yield* write(file, CLEAN)
            const result = yield* tool.execute({ command }, judged([], write(file, CHANGED)))
            expect(result.output).toBe(SCRIPT_CHANGED_TEXT)
            expect(result.metadata.exit).toBe(1)
            expect(yield* exists(path.join(tmp, "changed.txt"))).toBe(false)
          }
          expect(lines).toHaveLength(4)
          expect(lines[0]).toMatchObject({ type: "outcome", outcome: "not_run", by: "system:script_changed" })
        }),
      )
    }),
  )

  posixOnly("a script with no hash from before it was judged does not run", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* hashTool(true, [])
          const requests: Array<{ permission: string; metadata: Record<string, unknown> }> = []
          // Not there when judged, so nothing was hashed; there when it would run.
          const result = yield* tool.execute(
            { command: "./made.sh" },
            judged(requests, write(path.join(tmp, "made.sh"), CHANGED)),
          )
          expect(requests.find((item) => item.permission === "bash")?.metadata.scripts).toBeUndefined()
          expect(result.output).toBe(SCRIPT_CHANGED_TEXT)
          expect(yield* exists(path.join(tmp, "changed.txt"))).toBe(false)
          // Gone when it would run is no different.
          yield* write(path.join(tmp, "gone.sh"), CLEAN)
          const gone = yield* tool.execute(
            { command: "bash gone.sh" },
            judged(
              [],
              Effect.promise(() => import("fs/promises").then((fs) => fs.rm(path.join(tmp, "gone.sh")))),
            ),
          )
          expect(gone.output).toBe(SCRIPT_CHANGED_TEXT)
        }),
      )
    }),
  )

  posixOnly("a word that is no file either time, or inline code, runs as usual", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* hashTool(true, [])
          expect((yield* tool.execute({ command: "sh -c 'echo inline'" }, judged([]))).output.trim()).toBe("inline")
          const missing = yield* tool.execute({ command: "bash nothing.sh 2>/dev/null; echo after" }, judged([]))
          expect(missing.output.trim()).toBe("after")
        }),
      )
    }),
  )

  posixOnly("with the mode off nothing is hashed and the command runs as it is", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp, "run.sh")
      yield* write(file, CLEAN)
      const lines: unknown[] = []
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const tool = yield* hashTool(false, lines)
          const requests: Array<{ permission: string; metadata: Record<string, unknown> }> = []
          const result = yield* tool.execute({ command: "bash run.sh" }, judged(requests, write(file, CHANGED)))
          expect(result.output.trim()).toBe("ran")
          expect(yield* exists(path.join(tmp, "changed.txt"))).toBe(true)
          expect(requests.every((item) => item.metadata.scripts === undefined)).toBe(true)
          expect(lines).toEqual([])
        }),
      )
    }),
  )
})
