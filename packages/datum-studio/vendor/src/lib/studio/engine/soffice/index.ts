/**
 * Swarm TWIN (row 108, studio spec §1.3 and §2 E/F/H, §4): the engine/soffice barrel without
 * LibreOffice. The seven original files (index, log, paths, process, readiness, readiness-rules,
 * service) are not copied (spec §1.1). PDF is printed by Chromium from Studio's own HTML through the
 * render bridge (row 32 patches render.ts); there is no DOCX -> PDF.
 *
 * `checkRenderEnvReadiness` reports the render bridge (spec §2 E). Ready means:
 *   1. the bridge answers the `hello` handshake with the shared token;
 *   2. the bridge reports a locked-down render window (sandbox, context isolation, no Node, network
 *      blocked; engine/browser/runtime.ts `judgeBridgeInfo`);
 *   3. the 16 standard IBM Plex files of the Studio asset manifest exist and match their sha256.
 * Nothing of the Windows gate (HKCU font registry, GDI, reg.exe, render-env/*.mjs) is used.
 *
 * Kept exports with the same names so importers stay byte-identical: `checkRenderEnvReadiness`,
 * `resetReadinessCache`, `setSofficeLogSink`, `SofficeLogEntry`, `SofficeLogSink`.
 * `convertDocxToPdf` is kept ONLY as a refusing stub (PDF_ENGINE_UNAVAILABLE) until row 32 removes
 * its import from render.ts; it never converts anything.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RenderEnvReadiness } from "../../contract";
import { studioAssetsRoot } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { appendJsonlDaily } from "../../http/jsonl";
import { bridgeHandshake, type BridgeInfo } from "../browser/runtime";

export interface SofficeLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  /** Source name kept from the original so the job log routing (services/render/joblog.ts) is unchanged. */
  source: "studio.engine.soffice";
  message: string;
  code?: string;
  correlationId?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type SofficeLogSink = (e: SofficeLogEntry) => void | Promise<void>;

/** Default durable sink: daily JSONL under <STUDIO_WORKSPACE_ROOT>/logs/render-env/ (same helper as the original). */
async function fileSink(e: SofficeLogEntry): Promise<void> {
  await appendJsonlDaily("render-env", "render-env", e);
}

let sink: SofficeLogSink = fileSink;

/** Replace the log sink (null = back to the default file sink). */
export function setSofficeLogSink(s: SofficeLogSink | null): void {
  sink = s ?? fileSink;
}

function readinessLog(e: Omit<SofficeLogEntry, "timestamp" | "source">): void {
  const entry: SofficeLogEntry = { timestamp: new Date().toISOString(), source: "studio.engine.soffice", ...e };
  if (entry.level !== "info") console.error(JSON.stringify(entry));
  try {
    Promise.resolve(sink(entry)).catch((err: unknown) => {
      console.error(JSON.stringify({ source: entry.source, level: "error", message: "render-env log sink failed", detail: String(err) }));
    });
  } catch (err) {
    console.error(JSON.stringify({ source: entry.source, level: "error", message: "render-env log sink failed", detail: String(err) }));
  }
}

/** The bundled standard IBM Plex files (spec §1.1 row F: 16, no fonts/renamed/*). */
export const PLEX_FONT_RE = /^fonts\/IBMPlex[A-Za-z]+-[A-Za-z]+\.ttf$/;
export const PLEX_FONT_COUNT = 16;

/** Readiness plus what the bridge reported (additive field; the contract fields are unchanged). */
export type BridgeRenderEnvReadiness = RenderEnvReadiness & {
  bridge: { reachable: boolean; electron: string | null; chrome: string | null; sandbox: boolean | null };
};

const READINESS_TTL_MS = 30_000;
let cache: { at: number; value: BridgeRenderEnvReadiness } | null = null;

/** Drop the cached readiness (tests, or after the bridge restarts). */
export function resetReadinessCache(): void {
  cache = null;
}

function styleOf(file: string): string {
  return /-([A-Za-z]+)\.ttf$/.exec(file)?.[1] ?? "";
}

function familyOf(file: string): string {
  const stem = /^fonts\/(IBMPlex[A-Za-z]+)-/.exec(file)?.[1] ?? file;
  return stem.replace(/^IBMPlex/, "IBM Plex ").replace(/Cond$/, " Condensed").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function checkFonts(errors: string[]): { manifestSha256: string | null; fonts: RenderEnvReadiness["fonts"] } {
  let root: string;
  try {
    root = studioAssetsRoot();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return { manifestSha256: null, fonts: [] };
  }
  const mp = path.join(root, "manifest.json");
  if (!existsSync(mp)) {
    errors.push("Studio asset manifest not found");
    return { manifestSha256: null, fonts: [] };
  }
  const raw = readFileSync(mp);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  let entries: Array<{ path?: string; sha256?: string; kind?: string }>;
  try {
    const m = JSON.parse(raw.toString("utf8")) as { entries?: typeof entries };
    entries = Array.isArray(m.entries) ? m.entries : [];
  } catch {
    errors.push("Studio asset manifest is not valid JSON");
    return { manifestSha256, fonts: [] };
  }
  const plex = entries.filter((e): e is { path: string; sha256?: string; kind?: string } => typeof e.path === "string" && PLEX_FONT_RE.test(e.path));
  const fonts = plex
    .map((e) => {
      const abs = path.join(root, ...e.path.split("/"));
      const fileExists = existsSync(abs);
      const sha256Ok = fileExists && typeof e.sha256 === "string" && createHash("sha256").update(readFileSync(abs)).digest("hex") === e.sha256.toLowerCase();
      if (!fileExists) errors.push(`font file missing: ${e.path}`);
      else if (!sha256Ok) errors.push(`font sha256 mismatch: ${e.path}`);
      // "registered" = served to the render page as data: @font-face from the bundle (not an OS registration).
      return { family: familyOf(e.path), style: styleOf(e.path), fileExists, sha256Ok, registered: sha256Ok };
    })
    .sort((a, b) => (a.family + a.style < b.family + b.style ? -1 : 1));
  if (plex.length !== PLEX_FONT_COUNT) errors.push(`expected ${PLEX_FONT_COUNT} standard IBM Plex files in the manifest, found ${plex.length}`);
  return { manifestSha256, fonts };
}

/** Render readiness via the bridge (cached 30 s; `force` skips the cache). Never throws. */
export async function checkRenderEnvReadiness(opts?: { force?: boolean }): Promise<BridgeRenderEnvReadiness> {
  if (!opts?.force && cache && Date.now() - cache.at < READINESS_TTL_MS) return cache.value;
  const errors: string[] = [];
  let info: BridgeInfo | null = null;
  try {
    info = await bridgeHandshake();
  } catch (e) {
    errors.push(`render bridge not ready: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { manifestSha256, fonts } = checkFonts(errors);
  const value: BridgeRenderEnvReadiness = {
    ready: errors.length === 0,
    checkedAt: new Date().toISOString(),
    manifestSha256,
    // No LibreOffice in Swarm (spec §4): reported as absent; it is not part of readiness.
    soffice: { found: false, version: null, versionOk: false },
    chromium: { found: info !== null },
    fonts,
    errors,
    bridge: { reachable: info !== null, electron: info?.electron ?? null, chrome: info?.chrome ?? null, sandbox: info ? info.sandbox : null },
  };
  readinessLog({
    level: value.ready ? "info" : "warn",
    message: value.ready ? "render bridge ready" : "render bridge not ready",
    code: value.ready ? "RENDER_ENV_READY" : "RENDER_ENV_NOT_READY",
    context: { errors, electron: value.bridge.electron, fonts: fonts.length },
  });
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Removed (spec §1.3): there is no DOCX -> PDF in Swarm. Kept as a refusing stub so render.ts still
 * type-checks until row 32 moves the PDF step to the bridge `pdf` op and drops this import.
 */
export async function convertDocxToPdf(_docx: Uint8Array, i: { jobId: string; fileName: string }): Promise<{ pdf: Uint8Array; durationMs: number }> {
  readinessLog({ level: "error", message: "convertDocxToPdf called: no LibreOffice in Swarm", code: "PDF_ENGINE_UNAVAILABLE", correlationId: i.jobId });
  throw new StudioEngineError("PDF_ENGINE_UNAVAILABLE", "DOCX -> PDF is not available in Swarm; PDF is printed from the HTML through the render bridge");
}
