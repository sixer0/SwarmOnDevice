import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const name = process.platform === "win32" ? "rg.exe" : "rg"

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            // Resolution order fixed by masterplan/01a1_register_addendum.md AD-15 (I15):
            // the copies bundled with the artifact come first because the build recorded
            // their version and sha256, then the machine-managed slots (system PATH, then
            // the user-managed bin directory). The execPath candidates cover the CLI archive
            // and the installed CLI. They miss the desktop sidecar: a utilityProcess runs from
            // the Helper app, whose execPath/../Resources is not the app's Contents/Resources.
            // Electron's resourcesPath does point there; Bun leaves it undefined, so the CLI
            // and a source tree skip that candidate and fall through exactly as upstream.
            const execDir = path.dirname(process.execPath)
            const resourcesPath: unknown = Reflect.get(process, "resourcesPath")
            const candidates = [
              path.join(execDir, name),
              path.join(execDir, "..", "Resources", name),
              ...(typeof resourcesPath === "string" && path.isAbsolute(resourcesPath)
                ? [path.join(resourcesPath, name)]
                : []),
              yield* Effect.sync(() => which(name)),
              path.join(Global.Path.bin, name),
            ]
            for (const candidate of candidates) {
              if (!candidate) continue
              if (yield* fs.isFile(candidate).pipe(Effect.orDie)) return candidate
            }
            // Fail closed: there is deliberately no runtime provisioning step. Swarm never
            // retrieves executables over the network (decision 5; research/03b_endpoint_review.md E6/G4).
            const tried = candidates.map((candidate) => candidate ?? `${name} on PATH (not found)`)
            throw new Error(
              `ripgrep binary not found; Swarm performs no runtime retrieval of ripgrep. Tried:\n${tried.join("\n")}`,
            )
          }),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node],
  })
}
