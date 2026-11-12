// N-116 / N-186: the shipped tool-health registry (spec 01c section 4, TH-01). Five components, every path computed
// from the context, so the source and the serialised registry hold no machine path (registry.test.ts greps for it).
// `flux3` is never here: it lives in the user's ~/.config/swarm/tool-health.json only (N-128, C5).
//
// Values mirrored from packages/setup (desktop does not import setup at runtime; registry.test.ts fails on drift):
// - TOOL_HEALTH_SEARXNG_PORT / TOOL_HEALTH_FIRECRAWL_PORT = PC_PORTS.*Published.host (setup/src/composefiles/shared.ts)
// - TOOL_HEALTH_COLIMA_PROFILE = COLIMA_PROFILE (setup/src/constants.ts)

import { join } from "node:path"
import { ELK_STAGE_BUNDLE } from "../datum-studio-host/elk-runtime"
import { resolveStudioLayout } from "../datum-studio-host/layout"
import type { ToolHealthComponent, ToolHealthContext } from "./types"

/** The shipped ids, in probe order (01c section 4 table). */
export const TOOL_HEALTH_SHIPPED_IDS = ["runtime", "searxng", "firecrawl", "render-bridge", "layout-runtime"] as const
export type ShippedToolHealthId = (typeof TOOL_HEALTH_SHIPPED_IDS)[number]

export const TOOL_HEALTH_SEARXNG_PORT = 9021
export const TOOL_HEALTH_FIRECRAWL_PORT = 9022
export const TOOL_HEALTH_COLIMA_PROFILE = "swarm"

/** Setup's readiness rule (setup/src/readinessProbe.ts): any status below 400 serves. */
function statusRange(from: number, to: number): number[] {
  const out: number[] = []
  for (let s = from; s <= to; s++) out.push(s)
  return out
}

/** The ELK bundle the host would load for this layout; mirrors resolveElkBundle without touching the disk. */
export function layoutRuntimeBundlePath(ctx: ToolHealthContext): string {
  const layout = resolveStudioLayout({ isPackaged: ctx.isPackaged, resourcesPath: ctx.resourcesPath, appPath: ctx.appPath })
  if (layout.kind === "repo") return join(layout.vendorRoot, "..", "node_modules", "elkjs", "lib", "elk.bundled.js")
  return join(layout.vendorRoot, ...ELK_STAGE_BUNDLE.split("/"))
}

/** N-186: builds TOOL_HEALTH_COMPONENTS (N-116). A fresh array on every call; callers may not share mutations. */
export function createToolHealthRegistry(ctx: ToolHealthContext): ToolHealthComponent[] {
  const darwin = ["darwin"]
  return [
    {
      id: "runtime",
      label: "Container runtime (colima VM swarm)",
      probe: {
        kind: "http-unix",
        socketPath: join(ctx.home, ".colima", TOOL_HEALTH_COLIMA_PROFILE, "docker.sock"),
        path: "/_ping",
        expectStatus: 200,
      },
      revive: { builtin: "compose-start" },
      startup: "probe",
      consent: "auto",
      installedWhen: { setupComponent: "runtime" },
      reviveTimeoutMs: 180000,
      platforms: [...darwin],
    },
    {
      id: "searxng",
      label: "Web search (SearXNG)",
      probe: { kind: "http", url: `http://127.0.0.1:${TOOL_HEALTH_SEARXNG_PORT}/`, expectStatus: statusRange(200, 399) },
      revive: { builtin: "compose-start" },
      startup: "probe",
      consent: "auto",
      requires: ["runtime"],
      installedWhen: { setupComponent: "searxng" },
      reviveTimeoutMs: 60000,
      platforms: [...darwin],
    },
    {
      id: "firecrawl",
      label: "Web fetch (Firecrawl)",
      // 401/403: served behind the auth proxy (readinessProbe.ts). Row 92 may narrow this after measuring `/`.
      probe: {
        kind: "http",
        url: `http://127.0.0.1:${TOOL_HEALTH_FIRECRAWL_PORT}/`,
        expectStatus: [...statusRange(200, 399), 401, 403],
      },
      revive: { builtin: "compose-start" },
      startup: "probe",
      consent: "auto",
      requires: ["runtime"],
      installedWhen: { setupComponent: "firecrawl" },
      reviveTimeoutMs: 90000,
      platforms: [...darwin],
    },
    {
      id: "render-bridge",
      label: "DATUM render bridge",
      probe: { kind: "process", check: "render-bridge" },
      revive: { builtin: "render-bridge-restart" },
      startup: "probe",
      consent: "auto",
      reviveTimeoutMs: 15000,
    },
    {
      id: "layout-runtime",
      label: "Diagram layout runtime (ELK)",
      // No revive: the only fix is a reinstall or re-patch, and the regime never installs (01c 4.5, TH-06).
      probe: { kind: "file", path: layoutRuntimeBundlePath(ctx) },
      startup: "probe",
      consent: "auto",
    },
  ]
}

export function isShippedToolHealthId(id: string): id is ShippedToolHealthId {
  return (TOOL_HEALTH_SHIPPED_IDS as readonly string[]).includes(id)
}
