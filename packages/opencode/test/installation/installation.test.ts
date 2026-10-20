import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

// WP-EGRESS-CORE (row 56) turned every upgrade path into a refusal: Swarm ships no release feed
// (decisions.md GATE 2, decision 5), so `latest()` reports the installed version and both
// `upgrade()` and `upgradeMajor()` fail before touching a package manager or a download. The
// package-manager machinery stays in the module disable-not-delete for rebase parity, so these
// tests prove two things at once: the refusal text is what callers get, and none of the dead
// machinery is reached — zero HTTP requests and zero spawned processes on every path.
const encoder = new TextEncoder()

const METHODS = ["curl", "yarn", "unknown", "npm", "bun", "pnpm", "scoop", "choco", "brew"] as const

// Both fakes answer (a 599 and exit code 1) instead of hanging, so a leaked request or spawn shows
// up as an assertion failure on the recorded arrays rather than as a timeout.
function recorder() {
  const httpCalls: string[] = []
  const spawnCalls: string[] = []

  const client = HttpClient.make((request) => {
    httpCalls.push(request.url)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("upgrade paths must not reach the network", {
          status: 599,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  })
  const httpLayer = Layer.succeed(HttpClient.HttpClient, client)

  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    spawnCalls.push([std?.command ?? "", ...(std?.args ?? [])].join(" ").trim())
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: Stream.empty,
        stderr: Stream.make(encoder.encode("upgrade paths must not spawn installers")),
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    deps: [],
  })

  return {
    httpCalls,
    spawnCalls,
    layer: LayerNode.compile(Installation.node, [
      [httpClient, httpLayer],
      [CrossSpawnSpawner.node, spawnerNode],
    ]),
  }
}

describe("installation", () => {
  describe("isUpdate", () => {
    test("only counts newer releases in the installed major version", () => {
      expect(Installation.isUpdate("1.19.0", "1.19.1")).toBe(true)
      expect(Installation.isUpdate("1.19.0", "1.20.0")).toBe(true)
      expect(Installation.isUpdate("1.19.0", "1.19.0")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "1.18.35")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "2.0.0")).toBe(false)
      expect(Installation.isUpdate("1.9.0", "1.10.0")).toBe(true)
    })

    test("compares preview builds within their channel", () => {
      expect(Installation.isUpdate("0.0.0-dev-202610110139", "0.0.0-dev-202610120000")).toBe(true)
      expect(Installation.isUpdate("0.0.0-dev-202610120000", "0.0.0-dev-202610110139")).toBe(false)
    })

    test("source builds only accept releases in major version 1", () => {
      expect(Installation.isUpdate("local", "1.19.0")).toBe(true)
      expect(Installation.isUpdate("local", "2.0.0")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "not-a-version")).toBe(false)
    })
  })

  describe("refusal contract", () => {
    test("the build declares upgrades disabled and carries no upstream instructions URL", () => {
      expect(Installation.UPGRADES_DISABLED).toBe(true)
      // Row 56's fix round stripped the `opencode.ai/v2/docs` value; nothing may name a host.
      expect(Installation.MAJOR_INSTRUCTIONS).toBe("")
      expect(Installation.UPGRADE_REFUSAL).toContain("PT GSP")
      expect(Installation.UPGRADE_REFUSAL).not.toContain("http")
    })

    for (const method of METHODS) {
      const rec = recorder()
      testEffect(rec.layer).effect(`latest() reports the installed version for ${method}`, () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest(method)).toBe(InstallationVersion)
          expect(rec.httpCalls).toEqual([])
          expect(rec.spawnCalls).toEqual([])
        }),
      )
    }

    // Without an explicit method, `latest()` used to probe the install method first, which spawns
    // npm/brew queries. The refusal short-circuits ahead of that probe.
    const methodless = recorder()
    testEffect(methodless.layer).effect("latest() without a method probes nothing", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.latest()).toBe(InstallationVersion)
        expect(methodless.httpCalls).toEqual([])
        expect(methodless.spawnCalls).toEqual([])
      }),
    )

    for (const method of METHODS) {
      const rec = recorder()
      testEffect(rec.layer).effect(`upgrade(${method}) refuses without spawning or downloading`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "1.99.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe(Installation.UPGRADE_REFUSAL)
          expect(error.message).toBe(Installation.UPGRADE_REFUSAL)
          expect(rec.httpCalls).toEqual([])
          expect(rec.spawnCalls).toEqual([])
        }),
      )

      const majorTarget = recorder()
      testEffect(majorTarget.layer).effect(`upgrade(${method}) refuses a major target with the same text`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "2.0.27"))
          expect(error.stderr).toBe(Installation.UPGRADE_REFUSAL)
          // The old message pointed at `opencode upgrade --major`; the refusal must not leak it.
          expect(error.stderr).not.toContain("--major")
          expect(majorTarget.httpCalls).toEqual([])
          expect(majorTarget.spawnCalls).toEqual([])
        }),
      )

      const major = recorder()
      testEffect(major.layer).effect(`upgradeMajor(${method}) refuses without spawning or downloading`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgradeMajor(method))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe(Installation.UPGRADE_REFUSAL)
          expect(major.httpCalls).toEqual([])
          expect(major.spawnCalls).toEqual([])
        }),
      )
    }
  })
})
