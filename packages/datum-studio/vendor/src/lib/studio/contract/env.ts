/**
 * Env dan konstanta Studio (01_specs.md §7.1, C01-C17) serta `getStudioEnv`.
 *
 * Penjaga KT-03 / §14.1 butir 6: `STORAGE_ROOT_FORBIDDEN` bila akar Studio sama
 * dengan atau berada di dalam `SHARED_WORKSPACE` produksi. Pengecualian: bila
 * `SHARED_WORKSPACE` sendiri berada di dalam `data/` repo (sandbox uji E2E S80),
 * keduanya boleh menunjuk akar yang sama.
 *
 * Modul ini sengaja tanpa impor statis modul Node agar konstanta (C07-C17)
 * aman diimpor komponen klien; `node:path` diambil saat `getStudioEnv` /
 * `isPathInside` dipanggil (khusus server).
 *
 * Swarm patch (row 29, studio spec §2 A-J; on top of row 107 B/M4): single macOS host.
 * A/H: no LibreOffice (SOFFICE_PATH, STUDIO_SOFFICE_* removed). D/G: Chromium is Electron's
 * own behind the render bridge (STUDIO_CHROMIUM_PATH dropped). E: no render-env manifest
 * (STUDIO_RENDER_ENV_MANIFEST removed; readiness = bridge handshake, row 108). C: the
 * SHARED_WORKSPACE guard is replaced by {@link assertWorkspaceRootAllowed} (not `/`, not
 * `$HOME`, not inside `Res/` or the app bundle). No value here is resolved against cwd.
 * I: `process.getBuiltinModule` kept (Electron 42 Node 24.15.0). J: `samePath` kept.
 */
import { StudioEngineError } from "./errors";

function nodePath(): typeof import("node:path") {
  return process.getBuiltinModule("node:path");
}

// ── Env (default) ────────────────────────────────────────────────────────
// Swarm patch (row 29, spec §2 A, B, D, E): C01-C06 removed. There is no LibreOffice, no
// workspace default (the host always sets an absolute STUDIO_WORKSPACE_ROOT), no Chromium path
// (Electron's Chromium via the render bridge) and no render-env manifest.
/** Value of {@link StudioEnv.chromiumPath}: a label, not a path (spec §2 D). */
export const STUDIO_CHROMIUM_BRIDGE_LABEL = "electron:datum-render-bridge";

// ── Konstanta ────────────────────────────────────────────────────────────
/** C07 — per operasi halaman. */
export const STUDIO_CHROMIUM_TIMEOUT_MS = 30000;
/** C08 */
export const STUDIO_RENDER_JOB_TIMEOUT_MS = 600000;
/** C09 — 5 MiB. */
export const STUDIO_MAX_JSON_BYTES = 5242880;
/** C10 — 20 MiB per aset. */
export const STUDIO_MAX_ASSET_BYTES = 20971520;
/** C11 */
export const STUDIO_MAX_ASSETS_PER_DOC = 200;
/** C12 */
export const STUDIO_MAX_BLOCKS_PER_DOC = 20000;
/** C13 — per tabel. */
export const STUDIO_MAX_TABLE_CELLS = 5000;
/** C14 — per run. */
export const STUDIO_MAX_RUN_CHARS = 20000;
/** C15 — cek render-env di-cache 5 menit. */
export const STUDIO_READINESS_CACHE_MS = 300000;

/** C16 — satu sumber path route R01-R11 (§6.2) untuk UI/S68 (+R12-R20 SR-04, +R21-R23 DC-05). */
export const STUDIO_ROUTES = {
  R01: "/api/studio/templates",
  R02: "/api/studio/templates/[id]",
  R03: "/api/studio/registry",
  R04: "/api/studio/documents",
  R05: "/api/studio/documents/[id]",
  R06: "/api/studio/documents/[id]/blocks/[address]",
  R07: "/api/studio/documents/[id]/revisions",
  R08: "/api/studio/validate",
  R09: "/api/studio/artifacts",
  R10: "/api/studio/files/[id]",
  R11: "/api/studio/render-env",
  // Delta SR-04 (register §12): route struktur v2 R12-R20.
  R12: "/api/studio/chapters",
  R13: "/api/studio/slots",
  R14: "/api/studio/documents/[id]/structure",
  R15: "/api/studio/documents/[id]/completeness",
  R16: "/api/studio/documents/[id]/paragraphs/[pid]",
  R17: "/api/studio/documents/[id]/render",
  R18: "/api/studio/assets",
  R19: "/api/studio/templates/[id]/skeleton",
  R20: "/api/studio/documents/[id]/content",
  // Delta DC-05 (AM-06; register 05 §9): retrieval kontrak, teks penuh, cek draf.
  R21: "/api/studio/contracts",
  R22: "/api/studio/search",
  R23: "/api/studio/drafts/check",
} as const;
export type StudioRouteId = keyof typeof STUDIO_ROUTES;

/** Isi segmen dinamis `[id]`/`[address]`/`[pid]` (dienkode `encodeURIComponent`, §4.1). */
export function studioRoutePath(id: StudioRouteId, params: { id?: string; address?: string; pid?: string } = {}): string {
  return STUDIO_ROUTES[id]
    .replace("[id]", encodeURIComponent(params.id ?? ""))
    .replace("[address]", encodeURIComponent(params.address ?? ""))
    .replace("[pid]", encodeURIComponent(params.pid ?? ""));
}

/** C17 — 5 id skema §3 + SID01-SID05 kontrak v2 (delta SR-04; SID06 norm/v2 tidak dipublikasikan). */
export const STUDIO_SCHEMA_IDS = [
  "studio.doc/v1",
  "studio.chart/v1",
  "studio.diagram/v1",
  "studio.image/v1",
  "studio.html/v1",
  "studio.doc/v2",
  "studio.chapter/v2",
  "studio.slot/v2",
  "studio.template/v2",
  "studio.skeleton/v1",
] as const;
export type StudioSchemaId = (typeof STUDIO_SCHEMA_IDS)[number];
export const STUDIO_SCHEMA_BASE_URL = "https://hq.gsp.local/studio/schema";
export const STUDIO_COMMON_SCHEMA_ID = "common/v1";

// ── Delta SR-04: konstanta struktur v2 (register §16.1, C18-C33c) ──────────
// C29-C31 ada di schema/v2/forbidden.ts; C32a dan C33 milik L/registry/slots.ts (SR-05).
/** C18 */
export const SLOT_KEY_PATTERN = "^[a-z][a-zA-Z0-9]{0,31}$";
/** C19 */
export const PID_PATTERN = "^[a-z0-9][a-z0-9-]{2,63}$";
/** C20 */
export const PID_GENERATED_PREFIX = "p-";
/** C21 — base32 Crockford huruf kecil. */
export const PID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** C22 */
export const PID_RANDOM_LENGTH = 10;
/** C23 — maks 64 karakter. */
export const DOC_KEY_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";
/** C24 — kunci advisory `pg_advisory_xact_lock(hashtext('studio-doc:' || documentId))`. */
export const STUDIO_LOCK_DOC_PREFIX = "studio-doc:";
/** C25 — kunci pembuatan `'studio-mdoc:' || missionFolder || ':' || docKey`. */
export const STUDIO_LOCK_MISSION_DOC_PREFIX = "studio-mdoc:";
/** C26 — kunci peta `assets` kiriman v2. */
export const ASSET_KEY_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
/** C27 — rujukan aset langsung. */
export const ASSET_REF_PATTERN = "^sha256:[0-9a-f]{64}$";
/** C28 */
export const STUDIO_SUBMIT_TX_TIMEOUT_MS = 60000;
/** C32 */
export const STUDIO_COMMON_V2_SCHEMA_ID = "common/v2";
/** C33a — kunci bab slot `chapter`. */
export const CHAPTER_KEY_NUMERIC_PATTERN = "^[1-9][0-9]{0,2}$";
/** C33b — kunci bab slot `appendix`. */
export const CHAPTER_KEY_LETTER_PATTERN = "^[A-Z]$";
/** C33c — `relPath` M13 = `assets/<sha256[0..2]>/<sha256>.<png|jpg>` relatif `STUDIO_WORKSPACE_ROOT`. */
export const STUDIO_ASSET_REL_DIR = "assets";

// ── Delta DC-05: konstanta document contract (register 05 §14.1, C34-C57) ──
// C46/C47 milik L/http/quota.ts (DC-19); C58 milik L/registry/contracts.ts (DC-06);
// C59/C60 milik L/registry/charts.ts (DC-26).
/** C34 — kartu kanban `t_` + 8 heksa (inv §4 K1 :290). */
export const CARD_ID_PATTERN = "^t_[0-9a-f]{8}$";
/** C35 — butir `key`, `taskRef`, `dependsOn`, `evidence.item` (label non-heksa). */
export const CONTRACT_KEY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
/** C36 — pelaku (agen/profil), huruf kecil (CA-1). */
export const CONTRACT_ACTOR_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
/** C37 — `reportedAt`: tanggal, atau tanggal + waktu ber-zona (detik dan milidetik opsional). */
export const CONTRACT_REPORTED_AT_PATTERN =
  "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])(T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d{1,3})?)?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d))?$";
/** C38 — awalan sha256 bukti (8..64 heksa kecil). */
export const CONTRACT_SHA_PREFIX_PATTERN = "^[0-9a-f]{8,64}$";
/** C39 — batas larik dan panjang teks rujukan payload `contractRecord`. */
export const CONTRACT_LIMITS = { cardIds: 64, items: 500, dependsOn: 32, refs: 100, evidence: 200, refText: 500 } as const;
/** C40 — format bawaan render dokumen ber-contractKind tanpa `formats`/`figures` (KD-41). */
export const CONTRACT_DEFAULT_RENDER_FORMATS = ["HTML"] as const;
/** C41 — konfigurasi teks penuh Postgres. */
export const STUDIO_FTS_CONFIG = "simple";
/** C42 — potongan `textPlain` untuk kolom `tsv` (KD-37). */
export const STUDIO_FTS_MAX_CHARS = 100000;
/** C43 — batas R22. */
export const SEARCH_LIMITS = { qMin: 2, qMax: 200, takeDefault: 20, takeMax: 100 } as const;
/** C44 — opsi `ts_headline` cuplikan R22. */
export const SEARCH_SNIPPET_OPTIONS = "MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=2, StartSel=[[, StopSel=]]";
/** C45 — batas R21 (selaras `documents/route.ts:81-82`). */
export const CONTRACT_QUERY_LIMITS = { takeDefault: 50, takeMax: 200, statusListMax: 8 } as const;
/** C48 — sisa kuota bucket (QH-02). */
export const STUDIO_QUOTA_REMAINING_HEADER = "X-Studio-Quota-Remaining";
/** C49 — nama bucket E53 yang dilaporkan (QH-02, QH-04). */
export const STUDIO_QUOTA_BUCKET_HEADER = "X-Studio-Quota-Bucket";
/** C50 — nama final berkas pada setiap respons R10 (FN-06). */
export const STUDIO_FINAL_FILENAME_HEADER = "X-Studio-Final-Filename";
/** C51 — `<docNumberSafe>_rev<n>_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>` (FN-01). */
export const FINAL_FILENAME_PATTERN =
  "^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,78}[A-Za-z0-9])?)_rev(0|[1-9][0-9]{0,5})_([0-9]{8}T[0-9]{6}Z)_([0-9a-f]{8})\\.(docx|pdf|html|svg|png)$";
/**
 * Swarm patch (row 165D, F56-2, CP-17; manual Tabel 2.3 p.11-12): the DATUM name an output is DELIVERED under
 * (studio_file_verify, deliverables, the app's file tab), as built by storage/paths.ts `datumFileName` /
 * `datumDateFileName` / `datumPlainName` (figures) and kept in `output_file.file_name`:
 * `<Judul> <nomor-berkas> Rev<X>.<ext>`, `<Judul> <YYYY-MM-DD>.<ext>`, `Gambar <C.n> <Judul>.<ext>`, each with the
 * optional store collision suffix ` <sha8|sha16|sha64>` (storage/files.ts candidateNames). One path segment: no
 * `/`, `\`, `<>:"|?*`, control or bidi characters, no `_`, no leading space or dot, at most 255 characters.
 * The app copies this string verbatim (packages/app/src/pages/session/file-preview-policy.ts; a test pins it).
 */
export const DATUM_FILENAME_PATTERN =
  "^(?=[^\\u0000-\\u001f]{1,255}$)(?![ .])(?:(?:[^\\u0000-\\u001f\\u007f<>:\"/\\\\|?*_\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+ )?(?:[0-9A-Za-z][0-9A-Za-z.-]* Rev[0-9A-Za-z]{1,8}|[0-9]{4}-[0-9]{2}-[0-9]{2})|(?:Gambar|Figure) [0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)* [^\\u0000-\\u001f\\u007f<>:\"/\\\\|?*_\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+)(?: (?:[0-9a-f]{8}|[0-9a-f]{16}|[0-9a-f]{64}))?\\.(docx|pdf|html|svg|png)$";
/** C52 — panjang maks `docNumberSafe` (FN-02). */
export const FINAL_DOC_NUMBER_MAX = 80;
/** C53 — awalan nama final berkas artefak (FN-03). */
export const FINAL_ARTIFACT_PREFIX = "ART-";
/** C54 — batas R23 / CLI draf (413 DR-09/DR-10). */
export const DRAFT_LIMITS = { bodyBytes: 4194304, maxChars: 2000000, maxBlocks: 20 } as const;
/** C55 — kunci kepala draf MD (§11.1). */
export const DRAFT_HEADER_KEYS = ["tujuan", "langkah-berikut", "basis"] as const;
/** C56 — `basis` draf: `<documentId>@rev<n>` atau `baru`. */
export const DRAFT_BASIS_PATTERN = "^(?:([a-z0-9]{20,40})@rev([1-9][0-9]{0,5})|baru)$";
/** C57 — `$schema` blok draf yang diterima. */
export const DRAFT_ACCEPTED_SCHEMAS = ["studio.doc/v2", "studio.chapter/v2", "studio.slot/v2"] as const;

// ── getStudioEnv ─────────────────────────────────────────────────────────

export interface StudioEnv {
  /** Absolut. */
  workspaceRoot: string;
  /**
   * Swarm patch (row 29, spec §2 D): always {@link STUDIO_CHROMIUM_BRIDGE_LABEL}; kept only for
   * the informational `executablePath` of engine/browser/index.ts. Never an env value or a path.
   */
  chromiumPath: string;
}

let cached: StudioEnv | null = null;

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** true bila `child` sama dengan atau berada di dalam `parent` (keduanya absolut). */
export function isPathInside(child: string, parent: string): boolean {
  if (samePath(child, parent)) return true;
  const path = nodePath();
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Swarm patch (row 107, row 11 M3/M4): the Studio asset root is an explicit absolute path set by
// the host (`STUDIO_ASSETS_ROOT`), never derived from process.cwd(); template asset reads are
// confined to it after realpath (symlinks cannot leave the root).
export const STUDIO_ASSETS_ROOT_ENV = "STUDIO_ASSETS_ROOT";

/** Absolute Studio asset root (manifest.json, fonts/, logo/, base/). Missing or relative -> STORAGE_ROOT_FORBIDDEN. */
export function studioAssetsRoot(): string {
  const path = nodePath();
  const raw = process.env[STUDIO_ASSETS_ROOT_ENV]?.trim() ?? "";
  if (raw === "" || !path.isAbsolute(raw)) {
    throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", `${STUDIO_ASSETS_ROOT_ENV} must be an absolute path (no cwd fallback)`);
  }
  return path.resolve(raw);
}

/** `absPath` must be absolute and inside `root`, lexically and (when it exists) after realpath; else PATH_OUTSIDE_ROOT. */
export function assertPathInsideRoot(absPath: string, root: string, label = "path"): string {
  const path = nodePath();
  const fs = process.getBuiltinModule("node:fs");
  const out = () => new StudioEngineError("PATH_OUTSIDE_ROOT", `${label} outside root: ${absPath}`);
  if (typeof absPath !== "string" || absPath.includes("\u0000") || !path.isAbsolute(absPath)) throw out();
  const abs = path.resolve(absPath);
  if (!isPathInside(abs, path.resolve(root))) throw out();
  if (fs.existsSync(abs)) {
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    if (!isPathInside(fs.realpathSync(abs), realRoot)) throw out();
  }
  return abs;
}

/** Template asset read guard: inside {@link studioAssetsRoot}. */
export function assertStudioAssetPath(absPath: string, label = "template asset"): string {
  return assertPathInsideRoot(absPath, studioAssetsRoot(), label);
}

/** Injectable facts for {@link assertWorkspaceRootAllowed} (tests); defaults read the process. */
export interface WorkspaceRootFacts {
  home?: string | null;
  /** Electron `process.resourcesPath` (the app's `Contents/Resources`, "Res/"). */
  resourcesPath?: string | null;
  /** `process.execPath`; the app bundle is the outermost `*.app` ancestor. */
  execPath?: string | null;
}

/**
 * Outermost ancestor (or self) whose name ends in `.app`, else null. Outermost, because a utility
 * process runs from `Swarm.app/Contents/Frameworks/Swarm Helper.app/...`.
 */
function appBundleOf(p: string | null | undefined): string | null {
  if (!p) return null;
  const path = nodePath();
  let cur = path.resolve(p);
  let found: string | null = null;
  for (;;) {
    if (cur.toLowerCase().endsWith(".app")) found = cur;
    const up = path.dirname(cur);
    if (up === cur) return found;
    cur = up;
  }
}

function realOrSelf(p: string): string {
  const fs = process.getBuiltinModule("node:fs");
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Swarm patch (row 29, spec §2 C; replaces the SHARED_WORKSPACE guard): the workspace root must be
 * absolute, must not be `/` or `$HOME`, and must not be inside `Res/` or the app bundle. Checked
 * lexically and after realpath (when the path exists). Violations throw STORAGE_ROOT_FORBIDDEN.
 */
export function assertWorkspaceRootAllowed(root: string, facts: WorkspaceRootFacts = {}): string {
  const path = nodePath();
  const forbidden = (why: string) => new StudioEngineError("STORAGE_ROOT_FORBIDDEN", `STUDIO_WORKSPACE_ROOT ${why}`);
  if (typeof root !== "string" || root.includes("\u0000") || !path.isAbsolute(root)) throw forbidden("must be an absolute path (no cwd fallback)");
  const lexical = path.resolve(root);
  const candidates = [lexical, realOrSelf(lexical)];
  const os = process.getBuiltinModule("node:os");
  const home = facts.home !== undefined ? facts.home : process.env.HOME?.trim() || os.homedir();
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const res = facts.resourcesPath !== undefined ? facts.resourcesPath : typeof proc.resourcesPath === "string" ? proc.resourcesPath : null;
  const exec = facts.execPath !== undefined ? facts.execPath : process.execPath;
  const equalTo = [path.parse(lexical).root];
  if (home) equalTo.push(path.resolve(home));
  const insideOf: string[] = [];
  if (res) insideOf.push(path.resolve(res));
  for (const b of [appBundleOf(res), appBundleOf(exec)]) if (b) insideOf.push(b);
  for (const c of candidates) {
    for (const e of equalTo) if (samePath(c, e) || samePath(c, realOrSelf(e))) throw forbidden(`must not be ${e}`);
    for (const i of insideOf) if (isPathInside(c, i) || isPathInside(c, realOrSelf(i))) throw forbidden(`must not be inside ${i}`);
  }
  return lexical;
}

/** Baca env sekali (di-cache). Melempar STORAGE_ROOT_FORBIDDEN (KT-03; Swarm: spec §2 B, C). */
export function getStudioEnv(): StudioEnv {
  if (cached) return cached;
  const path = nodePath();
  // Swarm patch (row 107, M4 / studio spec §2 B): the workspace (document asset) read root has no
  // default and is never resolved against cwd; missing or relative is refused.
  const wsRaw = process.env.STUDIO_WORKSPACE_ROOT?.trim() ?? "";
  if (wsRaw === "" || !path.isAbsolute(wsRaw)) {
    throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", "STUDIO_WORKSPACE_ROOT must be an absolute path (no cwd fallback)");
  }
  // Swarm patch (row 29, spec §2 C): forbidden-root rule instead of the cwd-based SHARED_WORKSPACE guard.
  const workspaceRoot = assertWorkspaceRootAllowed(path.resolve(wsRaw));

  cached = { workspaceRoot, chromiumPath: STUDIO_CHROMIUM_BRIDGE_LABEL };
  return cached;
}

/** Untuk uji: lupakan cache sehingga env dibaca ulang. */
export function resetStudioEnvCache(): void {
  cached = null;
}
