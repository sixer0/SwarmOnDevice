/**
 * R18 `/api/studio/assets` (W-13, N-107; 01f §4.2; guide §10 "Aset gambar"). New in Swarm 1.2.6 (row 50b): the
 * route was documented and named in the ASSET_NOT_FOUND messages but never ported, so it answered 404.
 *
 * POST, one of:
 * - `multipart/form-data`, field `file`: body <= 20 MiB + 1 MiB envelope, checked from `Content-Length`
 *   before reading and again while reading (`ASSET_TOO_LARGE`); parsed with the runtime's
 *   `Request.formData()` (A1: present in Bun 1.3 and Node >= 18, verified in row 50b).
 * - JSON `{ mime?, dataBase64 }`: body <= 5 MiB (`STUDIO_MAX_JSON_BYTES`, `PAYLOAD_TOO_LARGE`).
 * - JSON `{ mime?, path }`: an absolute PNG/JPEG path inside the session file root only (N-108), symlinks
 *   resolved; outside -> 403 `PATH_OUTSIDE_ROOTS` (E-49). Size from stat before any read (r18-asset-path.ts).
 *   Exactly one of `dataBase64` and `path` (else 400 `SCHEMA_INVALID`).
 * `?mission=<folder>` is passed to `storeAsset` as the mission folder.
 * Type by content only: PNG and JPEG; SVG, GIF and the rest -> 415 `ASSET_TYPE_UNSUPPORTED`. Pixel limits
 * (20,000 px side, 80 MP) are checked from the header before the full decode (row 50a SEC-12).
 * Response `201 { asset, created: true, ref, metadata[, warning] }` or `200 { ..., created: false }` when the
 * sha256 already exists (dedupe; no quota charge). `metadata {gps, exifTags, pngTextKeys}` and the warning
 * line are report only (SEC-10 / C8): the bytes are stored verbatim. 60 uploads per minute per caller -> 429.
 *
 * GET `?sha256=<64 hex>` -> `200 { asset }`; unknown -> 404 `FILE_NOT_FOUND`; bad format -> 400 `SCHEMA_INVALID`.
 *
 * `asset` is `AssetDtoV2` (`toAssetDto`): no file path. Every error is logged durably through `apiLog`
 * (`<store>/logs/api`) and answered without a stack trace.
 */
import { STUDIO_ROUTES } from "@/lib/studio/contract/env";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { apiLog, createFixedWindowLimiter, failure, isRecord, json, NO_STORE, readBodyBytes, readJsonObject, reject, reqCtx, withCorrelation, type ReqCtx } from "@/lib/studio/http";
import {
  assertMultipartLength,
  assetRefOf,
  decodeImageDetailed,
  decodeImageFormField,
  findAssetBySha,
  IMAGE_MAX_MULTIPART_BYTES,
  storeAsset,
  toAssetDto,
  type DecodedImageDetail,
} from "@/lib/studio/services/images";
import { McpToolError } from "../../../../vendor/scripts/studio/mcp/safety";
import type { RouteContext } from "../types.ts";
import { ASSET_PATH_HTTP, assetMetadataWarning, readAssetFile } from "./r18-asset-path";

const ROUTE = STUDIO_ROUTES.R18;
const SOURCE = "studio.api.assets";
const SHA_RE = /^[0-9a-f]{64}$/i;
const JSON_KEYS: ReadonlySet<string> = new Set(["mime", "dataBase64", "path", "agentId"]);

/** Guide §10: 60 uploads per minute per caller. */
export const R18_UPLOADS_PER_MINUTE = 60;
const uploads = createFixedWindowLimiter({ limit: R18_UPLOADS_PER_MINUTE, windowMs: 60_000 });

/** Tests only: clear the per-caller upload window. */
export function resetAssetUploadLimiter(): void {
  uploads.reset();
}

export async function GET(req: Request, _rc: RouteContext): Promise<Response> {
  const ctx = reqCtx(req, ROUTE, SOURCE);
  const sha = new URL(req.url).searchParams.get("sha256") ?? "";
  if (!SHA_RE.test(sha)) {
    return reject(ctx, "SCHEMA_INVALID", "sha256 must be 64 hex characters", [{ pointer: "/sha256", keyword: "pattern", message: "must match ^[0-9a-f]{64}$" }]);
  }
  try {
    const row = await findAssetBySha(sha);
    if (!row) return reject(ctx, "FILE_NOT_FOUND", "Asset not found", { sha256: sha.toLowerCase() });
    return json({ asset: toAssetDto(row) }, 200, ctx, NO_STORE);
  } catch (e) {
    return failure(e, ctx, { op: "GET assets", context: { sha256: sha.toLowerCase() } });
  }
}

export async function POST(req: Request, rc: RouteContext): Promise<Response> {
  const ctx = reqCtx(req, ROUTE, SOURCE);
  const rate = uploads.hit(rc.caller.requester);
  if (!rate.allowed) {
    return reject(ctx, "RATE_LIMITED", "Too many asset uploads; retry later", { retryAfterSec: rate.retryAfterSec, limit: R18_UPLOADS_PER_MINUTE }, { requester: rc.caller.requester });
  }
  const mission = new URL(req.url).searchParams.get("mission") ?? undefined;
  try {
    const input = await readInput(req, ctx, rc);
    if (input instanceof Response) return input;
    const stored = await storeAsset(rc.caller, { file: input.img.bytes, ...(input.mime ? { mime: input.mime } : {}) }, mission, { correlationId: ctx.correlationId });
    const warning = assetMetadataWarning(input.img.metadata);
    apiLog({
      ...ctx,
      level: "info",
      message: stored.created ? "asset uploaded" : "asset upload deduplicated",
      code: stored.created ? "ASSET_UPLOADED" : "ASSET_DEDUPED",
      status: stored.created ? 201 : 200,
      context: { sha256: stored.asset.sha256, bytes: stored.asset.bytes, source: input.source, requester: rc.caller.requester, metadata: input.img.metadata },
    });
    return json(
      { asset: stored.asset, created: stored.created, ref: assetRefOf(stored.asset.sha256), metadata: input.img.metadata, ...(warning ? { warning } : {}) },
      stored.created ? 201 : 200,
      ctx,
      NO_STORE,
    );
  } catch (e) {
    if (e instanceof McpToolError) return pathRefusal(ctx, e);
    return failure(e, ctx, { op: "POST assets", context: { requester: rc.caller.requester } });
  }
}

type AssetInput = { img: DecodedImageDetail; mime?: string; source: "multipart" | "base64" | "path" };

async function readInput(req: Request, ctx: ReqCtx, rc: RouteContext): Promise<AssetInput | Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() === "multipart/form-data") return { img: await decodeImageFormField(await readForm(req, contentType)), source: "multipart" };
  const body = await readJsonObject(req, ctx);
  if (!body.ok) return body.response;
  const b = body.value;
  const extra = Object.keys(b).filter((k) => !JSON_KEYS.has(k));
  if (extra.length > 0) {
    return reject(ctx, "SCHEMA_INVALID", "Unknown field in asset upload body", extra.map((k) => ({ pointer: `/${k}`, keyword: "additionalProperties", message: "is not allowed" })));
  }
  if (b.mime !== undefined && typeof b.mime !== "string") return reject(ctx, "SCHEMA_INVALID", "mime must be a string", [{ pointer: "/mime", keyword: "type", message: "must be string" }]);
  const hasData = b.dataBase64 !== undefined;
  const hasPath = b.path !== undefined;
  if (hasData === hasPath) {
    return reject(ctx, "SCHEMA_INVALID", "Send exactly one of dataBase64 and path", [{ pointer: "", keyword: "oneOf", message: "exactly one of dataBase64, path" }]);
  }
  const mime = typeof b.mime === "string" ? b.mime : undefined;
  if (hasData) {
    if (typeof b.dataBase64 !== "string") return reject(ctx, "SCHEMA_INVALID", "dataBase64 must be a string", [{ pointer: "/dataBase64", keyword: "type", message: "must be string" }]);
    return { img: decodeImageDetailed({ base64: b.dataBase64 }), mime, source: "base64" };
  }
  const file = readAssetFile(b.path, rc.fileRoot ? [rc.fileRoot] : []);
  return { img: decodeImageDetailed({ bytes: file.bytes }), mime, source: "path" };
}

/** Multipart body: size from Content-Length first, then a capped read, then the runtime parser. */
async function readForm(req: Request, contentType: string): Promise<FormData> {
  assertMultipartLength(req.headers);
  const bytes = await readBodyBytes(req, IMAGE_MAX_MULTIPART_BYTES, "ASSET_TOO_LARGE");
  try {
    return await new Request(req.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
  } catch {
    throw new StudioEngineError("SCHEMA_INVALID", "multipart body could not be parsed", { reason: "multipart_malformed" });
  }
}

/** Read-side refusal of a `path` upload (MCP codes; ASSET_TOO_LARGE keeps its contract status). */
function pathRefusal(ctx: ReqCtx, e: McpToolError): Response {
  if (e.code === "ASSET_TOO_LARGE") return reject(ctx, "ASSET_TOO_LARGE", e.message, { reason: "file_too_large" });
  const status = ASSET_PATH_HTTP[e.code] ?? 400;
  const hint = e.code === "PATH_OUTSIDE_ROOTS" ? "Only files inside the session file root can be uploaded by path; copy the file into the project or send dataBase64." : undefined;
  apiLog({ ...ctx, level: "warn", message: `${e.code}: ${e.message}`.slice(0, 500), code: e.code, status });
  return withCorrelation(Response.json({ error: e.message, code: e.code, ...(hint ? { details: { hint } } : {}) }, { status, headers: NO_STORE }), ctx);
}
