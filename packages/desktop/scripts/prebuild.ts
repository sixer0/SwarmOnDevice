#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`
// Senior 3 (C82 c): fail before a macOS build when resources/swarm-setup is missing, incomplete or stale.
// The bundled swarm-setup is darwin-arm64 only, so other hosts do not check it.
if (process.platform === "darwin") await $`bun ./scripts/check-setup-stage.ts`

await $`cd ../opencode && bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
