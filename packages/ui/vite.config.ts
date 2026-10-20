import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import fs from "fs"

export default defineConfig({
  plugins: [
    solidPlugin(),
    providerIconsPlugin(),
    iconsSpritesheet([
      {
        withTypes: true,
        inputDir: "src/assets/icons/file-types",
        outputDir: "src/components/file-icons",
        formatter: "prettier",
      },
      {
        withTypes: true,
        inputDir: "src/assets/icons/provider",
        outputDir: "src/components/provider-icons",
        formatter: "prettier",
        iconNameTransformer: (iconName) => iconName,
      },
    ]),
  ],
  server: { port: 3001 },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})

function providerIconsPlugin() {
  return {
    name: "provider-icons-plugin",
    configureServer() {
      void fetchProviderIcons()
    },
    buildStart() {
      void fetchProviderIcons()
    },
  }
}

async function fetchProviderIcons() {
  // WP-EGRESS (row 68a, from H-R68-1): the upstream default host is removed — glyphs are
  // fetched only when an operator sets OPENCODE_MODELS_URL explicitly, mirroring the
  // fail-closed idiom row 56 applied in packages/core/src/models-dev.ts. Without the env,
  // the neutralised local files under src/assets/icons/provider stay the build input and
  // no network request is made at configureServer/buildStart.
  const url = process.env.OPENCODE_MODELS_URL
  if (!url) return
  const providers = await fetch(`${url}/api.json`)
    .then((res) => res.json())
    .then((json) => Object.keys(json))
  await Promise.all(
    providers.map((provider) =>
      fetch(`${url}/logos/${provider}.svg`)
        .then((res) => res.text())
        .then((svg) => fs.writeFileSync(`./src/assets/icons/provider/${provider}.svg`, svg)),
    ),
  )
}
