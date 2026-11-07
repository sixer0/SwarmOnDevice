// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2): the file-tab preview reads Studio
// outputs only through the existing file read (GET /file/content -> FileSystem.read). This pins the part of that path
// the preview relies on: files under the session root are read with their type, and a path whose realpath leaves the
// root (a symlink to a file outside, or a lexical escape) is refused.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n%%EOF\n")

describe("file-tab preview reads stay under the session root", () => {
  it.live("a Studio PDF and HTML under the root are read with their types", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "out")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "out", "GSP-Laporan_rev3.pdf"), PDF))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "out", "GSP-Laporan_rev3.html"), "<p>x</p>"))
        const service = yield* FileSystem.Service
        const pdf = yield* service.read({ path: RelativePath.make("out/GSP-Laporan_rev3.pdf") })
        const html = yield* service.read({ path: RelativePath.make("out/GSP-Laporan_rev3.html") })
        expect(pdf.mime).toBe("application/pdf")
        expect(Buffer.from(pdf.content).subarray(0, 5).toString("latin1")).toBe("%PDF-")
        expect(html.mime).toBe("text/html")
      }).pipe(provide(directory)),
    ),
  )

  it.live("a symlink inside the root that points at a PDF outside it is refused (realpath check)", () =>
    withTmp((outside) =>
      withTmp((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.pdf"), PDF))
          yield* Effect.promise(() => fs.symlink(path.join(outside, "secret.pdf"), path.join(directory, "link.pdf")))
          const result = yield* (yield* FileSystem.Service)
            .read({ path: RelativePath.make("link.pdf") })
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("a symlinked directory leading outside the root is refused too", () =>
    withTmp((outside) =>
      withTmp((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "page.html"), "<p>outside</p>"))
          yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "out")))
          const result = yield* (yield* FileSystem.Service)
            .read({ path: RelativePath.make("out/page.html") })
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("an absolute path and a climbing path are refused", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        for (const p of ["../outside.pdf", "out/../../outside.pdf", "/etc/hosts"]) {
          const result = yield* service.read({ path: RelativePath.make(p) }).pipe(Effect.exit)
          expect({ p, failed: Exit.isFailure(result) }).toEqual({ p, failed: true })
        }
      }).pipe(provide(directory)),
    ),
  )
})
