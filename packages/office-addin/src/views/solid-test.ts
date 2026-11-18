// Test-only: lets `bun test` render Solid components in happy-dom.
import { plugin } from "bun"
import { dirname, join } from "node:path"

const root = process.cwd()
const vps = Bun.resolveSync("vite-plugin-solid", root)
const vpsDir = vps.slice(0, vps.indexOf("/dist/"))
const solidServer = Bun.resolveSync("solid-js", root)
const solidDir = solidServer.slice(0, solidServer.indexOf("/dist/"))
const browser: Record<string, string> = {
  "solid-js": join(solidDir, "dist/solid.js"),
  "solid-js/web": join(solidDir, "web/dist/web.js"),
  "solid-js/store": join(solidDir, "store/dist/store.js"),
}

const rewrite = (code: string) =>
  code.replace(/(["'])(solid-js(?:\/web|\/store)?)\1/g, (all, _q, name: string) =>
    browser[name] ? JSON.stringify(browser[name]) : all,
  )

const babel = await import(Bun.resolveSync("@babel/core", vpsDir))
const solid = (await import(Bun.resolveSync("babel-preset-solid", vpsDir))).default
const ts = (await import(Bun.resolveSync("@babel/preset-typescript", vpsDir))).default

plugin({
  name: "solid-dom-test",
  setup(build) {
    build.onLoad({ filter: /\/office-addin\/src\/.*\.tsx?$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const tsx = args.path.endsWith(".tsx")
      const code = tsx
        ? ((
            await babel.transformAsync(source, {
              filename: args.path,
              presets: [[solid, { generate: "dom" }], [ts, { isTSX: true, allExtensions: true }]],
            })
          )?.code ?? "")
        : source
      const contents = rewrite(code)
      return { contents, loader: tsx ? "js" : "ts" }
    })
    // Browser builds of solid-js/web and store, and Solid libraries, import the bare "solid-js".
    build.onLoad({ filter: /(solid-js\/(web|store)\/dist\/(web|store)\.js|@solid-primitives\/.*\.js)$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      return { contents: rewrite(source), loader: "js" }
    })
  },
})
void dirname
