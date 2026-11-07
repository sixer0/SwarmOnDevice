/**
 * Sink JSONL harian bersama dengan retensi dan batas ukuran (FIX-1: S87 L-05,
 * S85 R-16).
 *
 * Satu implementasi untuk log route (`logs/api`) dan log layanan
 * (`logs/ingest|revisions|templates|storage`):
 * - berkas `<akar>/logs/<subdir>/<prefix>-YYYY-MM-DD.jsonl`; bila melewati
 *   `STUDIO_LOG_MAX_FILE_BYTES` (bawaan 50 MiB) entri berikutnya masuk
 *   `<prefix>-YYYY-MM-DD.<n>.jsonl` (n = 1..20; setelah itu entri dibuang dari
 *   berkas dan dilaporkan ke console, agar disk tidak tumbuh tanpa batas);
 * - retensi `STUDIO_LOG_RETENTION_DAYS` (bawaan 90 hari, GDPR Art. 5(1)(e)):
 *   berkas ber-pola milik prefix ini yang tanggalnya lebih tua dihapus, paling
 *   sering sekali per 6 jam per direktori, saat ada entri baru. Hanya berkas
 *   dengan pola nama persis `<prefix>-YYYY-MM-DD[.n].jsonl` yang disentuh.
 * Hanya runtime node.
 */
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { getStudioEnv } from "@/lib/studio/contract/env";

export const STUDIO_LOG_RETENTION_DAYS_DEFAULT = 90;
export const STUDIO_LOG_MAX_FILE_BYTES_DEFAULT = 50 * 1024 * 1024;
const MAX_PARTS = 20;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function logRetentionDays(): number {
  return envInt("STUDIO_LOG_RETENTION_DAYS", STUDIO_LOG_RETENTION_DAYS_DEFAULT, 1);
}

export function logMaxFileBytes(): number {
  return envInt("STUDIO_LOG_MAX_FILE_BYTES", STUDIO_LOG_MAX_FILE_BYTES_DEFAULT, 1024);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pola nama berkas log milik `prefix`; grup 1 = tanggal. */
export function logFilePattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRe(prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d{1,2}))?\\.jsonl$`);
}

const lastPurge = new Map<string, number>();

/**
 * Hapus berkas log `prefix` di `dir` yang tanggalnya lebih tua dari retensi.
 * Mengembalikan nama berkas yang dihapus. Galat per berkas dilewati.
 */
export async function purgeOldLogs(dir: string, prefix: string, now: number = Date.now(), retentionDays: number = logRetentionDays()): Promise<string[]> {
  const re = logFilePattern(prefix);
  const cutoff = now - retentionDays * DAY_MS;
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const day = Date.parse(`${m[1]}T00:00:00Z`);
    // Berkas hari D berisi entri sampai akhir hari D: hapus bila akhir harinya sudah lewat retensi.
    if (!Number.isFinite(day) || day + DAY_MS > cutoff) continue;
    try {
      await unlink(path.join(dir, name));
      removed.push(name);
    } catch {
      /* berkas sedang dipakai / sudah hilang: coba lagi pada purge berikutnya */
    }
  }
  return removed;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Berkas tujuan untuk hari `day` yang masih di bawah batas ukuran; null bila semua bagian penuh. */
async function targetFile(dir: string, prefix: string, day: string, maxBytes: number): Promise<string | null> {
  for (let part = 0; part <= MAX_PARTS; part++) {
    const file = path.join(dir, part === 0 ? `${prefix}-${day}.jsonl` : `${prefix}-${day}.${part}.jsonl`);
    if ((await sizeOf(file)) < maxBytes) return file;
  }
  return null;
}

/**
 * Tambahkan satu entri ke log JSONL harian `<akar>/logs/<subdir>/`.
 * Melempar bila akar Studio tidak sah (pemanggil melaporkannya ke console).
 */
export async function appendJsonlDaily(subdir: string, prefix: string, entry: { timestamp: string }): Promise<void> {
  const dir = path.join(getStudioEnv().workspaceRoot, "logs", subdir);
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  if (now - (lastPurge.get(dir) ?? 0) >= PURGE_INTERVAL_MS) {
    lastPurge.set(dir, now);
    void purgeOldLogs(dir, prefix, now).catch(() => undefined);
  }
  const file = await targetFile(dir, prefix, entry.timestamp.slice(0, 10), logMaxFileBytes());
  if (!file) {
    console.error(JSON.stringify({ source: "studio.log", level: "error", message: "daily log size cap reached; entry not written to file", context: { subdir, prefix } }));
    return;
  }
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

/** Hanya untuk uji: lupakan jadwal purge per direktori. */
export function resetLogPurgeSchedule(): void {
  lastPurge.clear();
}
