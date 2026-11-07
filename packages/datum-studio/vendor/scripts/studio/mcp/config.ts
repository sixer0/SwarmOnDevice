/**
 * Konfigurasi server MCP Studio (MCP-01, D-449/D-450/D-457; pengerasan MCP-04, D-461/D-462) dari env proses.
 *
 * - `STUDIO_BASE_URL`      server Studio (bawaan http://127.0.0.1:9021); satu-satunya host yang boleh
 *                          menerima rahasia (lihat `safety.ts` guardedFetch). http hanya untuk host
 *                          loopback (127.0.0.1, ::1, localhost); host lain wajib https (L-4).
 * - `INTERNAL_API_SECRET`  rahasia internal; dikirim HANYA sebagai header `x-internal-secret` lewat
 *                          klien bersama `../_http-client`; tidak pernah dicetak, dicatat, atau
 *                          dikembalikan dalam hasil alat (disensor ulang oleh `redact`). Nilai kosong atau
 *                          rujukan env yang tidak terisi (`${...}`, `%NAMA%`) = belum diisi -> SECRET_MISSING (P-3).
 * - `STUDIO_AGENT_ID`      agentId bawaan (dapat ditimpa per panggilan alat, kecuali dikunci).
 * - `STUDIO_MCP_LOCK_AGENT_ID` `1`/`true`: agentId selalu `STUDIO_AGENT_ID`; argumen atau baris laporan
 *                          dengan agentId lain ditolak AGENT_ID_LOCKED (L-1; satu proses server per agen).
 * - `STUDIO_MCP_FILE_ROOTS` akar folder (dipisah `;` di Windows, `:` di POSIX). MEMBACA laporan dari `path`
 *                          diizinkan di akar ini (bawaan: cwd proses server). MENULIS berkas (refresh
 *                          `write`/`outPath`, unduhan `downloadDir`) HANYA bila env ini diisi eksplisit;
 *                          tanpa env -> FILE_WRITE_DISABLED (M-1). Path UNC/perangkat ditolak (M-2).
 * - `STUDIO_MCP_TOOLSETS`  MCP-D1 (D-475): daftar toolset dipisah koma (`reports`, `documents`, `query`, atau
 *                          `all`); bawaan semua. Hanya alat toolset itu yang muncul di tools/list (beban token
 *                          per giliran lebih kecil). Nama tak dikenal -> CONFIG_INVALID. `write` (IMPL-W) hanya
 *                          bila disebut eksplisit (tidak termasuk bawaan maupun `all`).
 */
import path from "node:path";
import { normalizeBaseUrl } from "../_http-client";

export const DEFAULT_STUDIO_BASE_URL = "http://127.0.0.1:9021";
// Swarm patch (row 29, studio spec §1.3, register §1 and §5): server identity in Swarm.
export const MCP_SERVER_NAME = "datum-studio";
export const MCP_SERVER_VERSION = "1.2.0";

/** Batas badan laporan/draf: sama dengan C54 `DRAFT_LIMITS.bodyBytes` (4 MiB). */
export const MAX_INPUT_BYTES = 4_194_304;
/** Batas satu pesan JSON-RPC stdio (bita); pesan lebih besar menutup transport (SDK). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** MCP-D1: kelompok alat. reports = laporan kerja; documents = dokumen klien; query = cari/baca. */
// Swarm patch (row 29): studio spec §5.1 (documents, query, write, templates; all on by default, `write`
// no longer opt-in) plus mission contract §8.1 (U19: `reports` KEPT again, `missions` NEW, both on).
export const TOOLSETS = ["documents", "query", "write", "templates", "reports", "missions"] as const;
/**
 * IMPL-W (D-522): toolset `write` (jalur tulis minimal: studio_write, studio_edit + alat baca) hanya bila disebut
 * eksplisit di STUDIO_MCP_TOOLSETS; bawaan dan `all` tetap tiga toolset lama agar beban per giliran konfigurasi
 * yang sudah ada tidak berubah. Swarm patch (row 29, spec §5.1): no opt-in toolset is left.
 */
export const OPT_IN_TOOLSETS = [] as const;
export type Toolset = (typeof TOOLSETS)[number] | (typeof OPT_IN_TOOLSETS)[number];

export type SecretIssue = "empty" | "unresolved-reference";

export interface StudioMcpConfig {
  /** Hasil `normalizeBaseUrl` (asal + path tanpa garis miring akhir). */
  baseUrl: string;
  /** Asal (`protocol//host:port`) yang boleh menerima permintaan. */
  origin: string;
  /** "" = belum diisi: alat yang memerlukan server menjawab SECRET_MISSING. */
  secret: string;
  /** Mengapa rahasia dianggap belum diisi (null = terisi). */
  secretIssue: SecretIssue | null;
  defaultAgentId: string | null;
  /** L-1: agentId dikunci ke `defaultAgentId`. */
  lockAgentId: boolean;
  /** Akar absolut (sudah di-resolve) untuk baca `path` (dan tulis, bila {@link fileWriteEnabled}). */
  fileRoots: string[];
  /** M-1: tulis berkas hanya bila `STUDIO_MCP_FILE_ROOTS` diisi eksplisit (tanpa bawaan cwd). */
  fileWriteEnabled: boolean;
  /** MCP-D1: toolset aktif (urutan TOOLSETS); bawaan semua. */
  toolsets: Toolset[];
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
}

const AGENT_ID_RE = /^[^\u0000-\u001f]{1,80}$/;
/** Rujukan env yang tidak dikembangkan klien MCP (Hermes meneruskan `${env:X}` literal, P-3). */
const UNRESOLVED_REF_RE = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Rahasia efektif: kosong/spasi atau rujukan env tak terisi -> "" (belum diisi). */
export function normalizeSecret(raw: string | undefined): { secret: string; issue: SecretIssue | null } {
  const v = (raw ?? "").trim();
  if (v === "") return { secret: "", issue: "empty" };
  if (UNRESOLVED_REF_RE.test(v)) return { secret: "", issue: "unresolved-reference" };
  return { secret: raw as string, issue: null };
}

const isUncLike = (p: string): boolean => /^[\\/]{2}/.test(p);

export function loadConfig(env: Readonly<Record<string, string | undefined>>, cwd: string): StudioMcpConfig {
  const rawUrl = env.STUDIO_BASE_URL && env.STUDIO_BASE_URL.trim() !== "" ? env.STUDIO_BASE_URL.trim() : DEFAULT_STUDIO_BASE_URL;
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch {
    throw new ConfigError(`STUDIO_BASE_URL harus URL http(s) yang sah, mis. ${DEFAULT_STUDIO_BASE_URL}`);
  }
  const url = new URL(baseUrl);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(`STUDIO_BASE_URL http hanya untuk host loopback (127.0.0.1, ::1, localhost); host ${url.hostname} wajib https agar rahasia tidak terkirim tanpa TLS`);
  }
  const agent = env.STUDIO_AGENT_ID?.trim() ?? "";
  if (agent !== "" && !AGENT_ID_RE.test(agent)) throw new ConfigError("STUDIO_AGENT_ID harus 1..80 karakter tanpa karakter kontrol");
  const lockRaw = (env.STUDIO_MCP_LOCK_AGENT_ID ?? "").trim().toLowerCase();
  const lockAgentId = lockRaw === "1" || lockRaw === "true";
  if (lockAgentId && agent === "") throw new ConfigError("STUDIO_MCP_LOCK_AGENT_ID memerlukan STUDIO_AGENT_ID");
  const rootsRaw = env.STUDIO_MCP_FILE_ROOTS?.trim() ?? "";
  const explicit = rootsRaw !== "";
  // Swarm patch (row 107, row 11 M1): no process.cwd() read-root fallback; an empty root list is
  // refused at startup (the host always passes explicit roots). `cwd` is kept for the signature only.
  void cwd;
  const roots = (explicit ? rootsRaw.split(path.delimiter) : []).map((r) => r.trim()).filter((r) => r !== "");
  if (roots.length === 0) throw new ConfigError("STUDIO_MCP_FILE_ROOTS wajib diisi path absolut (tanpa cadangan cwd)");
  const bad = roots.find((r) => !path.isAbsolute(r));
  if (bad !== undefined) throw new ConfigError(`STUDIO_MCP_FILE_ROOTS hanya menerima path absolut (diberikan "${bad}")`);
  const unc = roots.find(isUncLike);
  if (unc !== undefined) throw new ConfigError(`STUDIO_MCP_FILE_ROOTS tidak menerima path UNC/perangkat (diberikan "${unc}"); pakai folder lokal`);
  const toolsets = parseToolsets(env.STUDIO_MCP_TOOLSETS);
  const { secret, issue } = normalizeSecret(env.INTERNAL_API_SECRET);
  return {
    baseUrl,
    origin: url.origin,
    secret,
    secretIssue: issue,
    defaultAgentId: agent === "" ? null : agent,
    lockAgentId,
    fileRoots: roots.map((r) => path.resolve(r)),
    fileWriteEnabled: explicit,
    toolsets,
  };
}

/** `STUDIO_MCP_TOOLSETS`: kosong/`all` = semua; selain nama TOOLSETS -> ConfigError. */
export function parseToolsets(raw: string | undefined): Toolset[] {
  const names = (raw ?? "").split(",").map((n) => n.trim().toLowerCase()).filter((n) => n !== "");
  const known: readonly string[] = [...TOOLSETS, ...OPT_IN_TOOLSETS];
  const bad = names.filter((n) => n !== "all" && !known.includes(n));
  if (bad.length > 0) throw new ConfigError(`STUDIO_MCP_TOOLSETS memuat nama tak dikenal: ${bad.join(", ")}; pilihan: ${known.join(", ")}, all`);
  const optIn = OPT_IN_TOOLSETS.filter((t) => names.includes(t));
  if (names.length === 0 || names.includes("all")) return [...TOOLSETS, ...optIn];
  return [...TOOLSETS.filter((t) => names.includes(t)), ...optIn];
}

/** Ringkasan konfigurasi yang AMAN dicetak (tanpa rahasia; hanya apakah terisi). */
export function describeConfig(c: StudioMcpConfig): Record<string, unknown> {
  return {
    baseUrl: c.baseUrl,
    secretSet: c.secret !== "",
    ...(c.secretIssue !== null ? { secretIssue: c.secretIssue } : {}),
    defaultAgentId: c.defaultAgentId,
    lockAgentId: c.lockAgentId,
    fileRoots: c.fileRoots,
    fileWrite: c.fileWriteEnabled ? "enabled" : "disabled (STUDIO_MCP_FILE_ROOTS tidak diisi)",
    toolsets: c.toolsets,
  };
}
