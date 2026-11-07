/**
 * Dekode aset raster tak tepercaya (S53, I43 `decodeImage`): base64 (teks
 * polos atau data URI PNG/JPEG) atau byte mentah (multipart). Urutan
 * penjagaan: ukuran sebelum dekode -> dekode base64 ketat -> ukuran byte ->
 * sniff magic bytes (PNG/JPEG saja; SVG mentah dan format lain ditolak) ->
 * header (dimensi, tanpa dekompresi) -> batas piksel -> sha256.
 */
import { STUDIO_MAX_ASSET_BYTES } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { sha256Hex, storageLog } from "../storage";
import { sniffRaster, type RasterHeader, type RasterMime } from "./sniff";

/** Sisi terpanjang yang diterima (piksel). Gambar figur 300 dpi A3 penuh = 4961 px. */
export const IMAGE_MAX_SIDE_PX = 20000;
/** Batas luas (piksel) agar konsumen hilir (Chromium, Word, LibreOffice) tidak menerima bom dekompresi. */
export const IMAGE_MAX_PIXELS = 80_000_000;
/** Plafon panjang teks base64 yang diterima (= 4/3 batas aset + ruang prefiks data URI dan spasi baris). */
export const IMAGE_MAX_BASE64_CHARS = Math.ceil(STUDIO_MAX_ASSET_BYTES / 3) * 4 + 1 * 1024 * 1024;

export const IMAGE_SOURCE = "studio.services.images";

export interface DecodedImage {
  mime: RasterMime;
  widthPx: number;
  heightPx: number;
  bytes: Uint8Array;
  sha256: string;
}

export interface DecodedImageDetail extends DecodedImage {
  header: RasterHeader;
}

function reject(code: "SCHEMA_INVALID" | "ASSET_TOO_LARGE" | "ASSET_TYPE_UNSUPPORTED", message: string, details: Record<string, unknown>): never {
  // Galat masukan (4xx) dicatat warn tanpa isi berkas: hanya kode, alasan, angka.
  storageLog({ level: "warn", message: `image rejected: ${message}`, code: `IMAGE_${code}`, context: { module: IMAGE_SOURCE, ...details } });
  throw new StudioEngineError(code, message, details);
}

const DATA_URI_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9.+-]+=[^;,]*)*);base64,/i;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Dekode base64 ketat. Menerima teks polos atau data URI `image/png` /
 * `image/jpeg` / `image/jpg`; spasi/baris baru diabaikan; padding boleh
 * hilang. Karakter di luar alfabet standar (termasuk base64url) ditolak.
 */
export function decodeBase64Strict(input: string): Uint8Array {
  if (typeof input !== "string") reject("SCHEMA_INVALID", "base64 must be a string", { reason: "base64_not_string" });
  if (input.length > IMAGE_MAX_BASE64_CHARS) {
    reject("ASSET_TOO_LARGE", `asset exceeds ${STUDIO_MAX_ASSET_BYTES} bytes`, { reason: "base64_too_long", limitBytes: STUDIO_MAX_ASSET_BYTES });
  }
  let body = input.trim();
  const m = DATA_URI_RE.exec(body.slice(0, 256));
  if (m) {
    const declared = m[1].toLowerCase();
    if (declared !== "image/png" && declared !== "image/jpeg" && declared !== "image/jpg") {
      reject("ASSET_TYPE_UNSUPPORTED", `data URI type ${declared} is not supported (PNG/JPEG only)`, { reason: "data_uri_type", declared });
    }
    body = body.slice(m[0].length);
  } else if (/^data:/i.test(body)) {
    reject("SCHEMA_INVALID", "data URI must be base64-encoded", { reason: "data_uri_not_base64" });
  }
  body = body.replace(/[\s]+/g, "");
  if (body.length === 0) reject("SCHEMA_INVALID", "base64 is empty", { reason: "base64_empty" });
  if (!BASE64_BODY_RE.test(body)) reject("SCHEMA_INVALID", "base64 contains invalid characters", { reason: "base64_charset" });
  const unpadded = body.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) reject("SCHEMA_INVALID", "base64 length is invalid", { reason: "base64_length" });
  if (body.length !== unpadded.length && body.length % 4 !== 0) reject("SCHEMA_INVALID", "base64 padding is invalid", { reason: "base64_padding" });
  const decodedLen = Math.floor((unpadded.length * 3) / 4);
  if (decodedLen > STUDIO_MAX_ASSET_BYTES) {
    reject("ASSET_TOO_LARGE", `asset exceeds ${STUDIO_MAX_ASSET_BYTES} bytes`, { reason: "decoded_too_large", bytes: decodedLen, limitBytes: STUDIO_MAX_ASSET_BYTES });
  }
  const buf = Buffer.from(unpadded, "base64");
  if (buf.byteLength !== decodedLen) reject("SCHEMA_INVALID", "base64 could not be decoded", { reason: "base64_decode" });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Sama dengan `decodeImage`, ditambah header lengkap (DPI tertanam, orientasi EXIF, rincian format). */
export function decodeImageDetailed(input: { base64?: string; bytes?: Uint8Array }): DecodedImageDetail {
  if (input === null || typeof input !== "object") reject("SCHEMA_INVALID", "image input is required", { reason: "input_missing" });
  const hasB64 = input.base64 !== undefined;
  const hasBytes = input.bytes !== undefined;
  if (hasB64 === hasBytes) reject("SCHEMA_INVALID", "exactly one of base64/bytes is required", { reason: "input_ambiguous" });

  let bytes: Uint8Array;
  if (hasBytes) {
    if (!(input.bytes instanceof Uint8Array)) reject("SCHEMA_INVALID", "bytes must be a Uint8Array", { reason: "bytes_type" });
    bytes = input.bytes;
  } else {
    bytes = decodeBase64Strict(input.base64 as string);
  }
  if (bytes.byteLength === 0) reject("SCHEMA_INVALID", "image is empty", { reason: "empty" });
  if (bytes.byteLength > STUDIO_MAX_ASSET_BYTES) {
    reject("ASSET_TOO_LARGE", `asset exceeds ${STUDIO_MAX_ASSET_BYTES} bytes`, { reason: "bytes_too_large", bytes: bytes.byteLength, limitBytes: STUDIO_MAX_ASSET_BYTES });
  }

  const sniff = sniffRaster(bytes);
  if (!sniff.ok) {
    const corrupt = sniff.kind === "png" || sniff.kind === "jpeg";
    reject(
      "ASSET_TYPE_UNSUPPORTED",
      corrupt ? `invalid ${sniff.kind.toUpperCase()}: ${sniff.reason}` : sniff.reason,
      { reason: corrupt ? "corrupt_header" : "unsupported_type", detected: sniff.kind },
    );
  }
  const h = sniff.header;
  if (h.widthPx > IMAGE_MAX_SIDE_PX || h.heightPx > IMAGE_MAX_SIDE_PX || h.widthPx * h.heightPx > IMAGE_MAX_PIXELS) {
    reject("ASSET_TOO_LARGE", `image ${h.widthPx}x${h.heightPx} px exceeds pixel limits`, {
      reason: "pixel_limit",
      widthPx: h.widthPx,
      heightPx: h.heightPx,
      maxSidePx: IMAGE_MAX_SIDE_PX,
      maxPixels: IMAGE_MAX_PIXELS,
    });
  }
  return { mime: h.mime, widthPx: h.widthPx, heightPx: h.heightPx, bytes, sha256: sha256Hex(bytes), header: h };
}

/**
 * I43: dekode + validasi aset raster. Galat bertipe `StudioEngineError`:
 * `SCHEMA_INVALID` (400) masukan rusak, `ASSET_TOO_LARGE` (413),
 * `ASSET_TYPE_UNSUPPORTED` (415, termasuk SVG mentah dan PNG/JPEG rusak).
 */
export function decodeImage(input: { base64?: string; bytes?: Uint8Array }): DecodedImage {
  const { mime, widthPx, heightPx, bytes, sha256 } = decodeImageDetailed(input);
  return { mime, widthPx, heightPx, bytes, sha256 };
}

// ── Multipart (route R09 `file`) ─────────────────────────────────────────

/**
 * Plafon `Content-Length` permintaan multipart sebelum `request.formData()`
 * (Next mem-buffer seluruh badan): satu aset + 1 MiB untuk medan lain.
 */
export const IMAGE_MAX_MULTIPART_BYTES = STUDIO_MAX_ASSET_BYTES + 1024 * 1024;

/**
 * Tolak permintaan multipart yang terlalu besar dari header saja. Header
 * absen/tidak sah tidak ditolak di sini (route tetap memeriksa ukuran berkas).
 */
export function assertMultipartLength(headers: Headers): void {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return;
  const n = Number(raw);
  if (n > IMAGE_MAX_MULTIPART_BYTES) {
    reject("ASSET_TOO_LARGE", `request exceeds ${IMAGE_MAX_MULTIPART_BYTES} bytes`, { reason: "multipart_too_large", bytes: n, limitBytes: IMAGE_MAX_MULTIPART_BYTES });
  }
}

/** Bagian berkas multipart (`File`/`Blob`); tipe dari klien diabaikan, MIME diambil dari magic bytes. */
export async function decodeImageBlob(file: Blob): Promise<DecodedImageDetail> {
  if (!file || typeof file !== "object" || typeof (file as Blob).arrayBuffer !== "function") {
    reject("SCHEMA_INVALID", "multipart field is not a file", { reason: "not_file" });
  }
  if (file.size > STUDIO_MAX_ASSET_BYTES) {
    reject("ASSET_TOO_LARGE", `asset exceeds ${STUDIO_MAX_ASSET_BYTES} bytes`, { reason: "file_too_large", bytes: file.size, limitBytes: STUDIO_MAX_ASSET_BYTES });
  }
  const out = decodeImageDetailed({ bytes: new Uint8Array(await file.arrayBuffer()) });
  const declared = (file.type || "").toLowerCase();
  if (declared && declared !== out.mime && !(declared === "image/jpg" && out.mime === "image/jpeg")) {
    storageLog({ level: "warn", message: "declared multipart type differs from sniffed type", code: "IMAGE_TYPE_MISMATCH", context: { module: IMAGE_SOURCE, declared, sniffed: out.mime } });
  }
  return out;
}

/** Ambil medan berkas (default `file`) dari FormData lalu dekode. */
export async function decodeImageFormField(form: FormData, field = "file"): Promise<DecodedImageDetail> {
  const v = form.get(field);
  if (v === null) reject("SCHEMA_INVALID", `multipart field "${field}" is required`, { reason: "field_missing", field });
  if (typeof v === "string") reject("SCHEMA_INVALID", `multipart field "${field}" must be a file`, { reason: "field_not_file", field });
  return decodeImageBlob(v);
}
