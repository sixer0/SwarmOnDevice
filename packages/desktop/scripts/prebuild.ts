#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`
// Senior 3 (C82 c): fail before a macOS build when resources/swarm-setup is missing, incomplete or stale.
// The bundled swarm-setup is darwin-arm64 only, so other hosts do not check it.
if (process.platform === "darwin") await $`bun ./scripts/check-setup-stage.ts`
// C120: the same gate for the swarm command slot (bun ./scripts/stage-cli.ts).
if (process.platform === "darwin") await $`bun ./scripts/check-cli-stage.ts`
// Row 45 (packaging spec §3.1): the same gate for the three DATUM folders (skill copy, runtime and Studio stages).
if (process.platform === "darwin") await $`bun ./scripts/check-datum-stage.ts stage`

await $`cd ../opencode && bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
