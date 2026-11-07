/**
 * Identitas pid (SR-10; register §10, T2-55 `PidAllocator`, KD-22).
 *
 * - Bangkitan acak (layanan DB): `"p-"` + 10 karakter base32 Crockford huruf
 *   kecil dari `crypto.randomBytes` (50 bit).
 * - Bangkitan berbenih (jalur murni CLI/uji): `"p-" + crockford(sha256(seed + ":" + ordinal))[0..10]`.
 * - Pid bab: `bab-<kunci>` (slot `chapter`) / `lamp-<kunci huruf kecil>` (slot
 *   `appendix`) bila belum pernah dipakai dokumen (termasuk pid pensiun), selain
 *   itu `<dasar>-<m>` dengan m = 2, 3, … terkecil yang bebas.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  PID_ALPHABET,
  PID_GENERATED_PREFIX,
  PID_PATTERN,
  PID_RANDOM_LENGTH,
  type PidAllocator,
  type StudioIdentityKind,
} from "../../contract";
import type { StructureDb } from "./types";

const PID_RE = new RegExp(PID_PATTERN);
/** Batas percobaan bila bangkitan bertabrakan (praktis tidak pernah terjadi pada 50 bit). */
const MAX_COLLISION_RETRIES = 32;

export function isValidPid(pid: string): boolean {
  return typeof pid === "string" && PID_RE.test(pid);
}

/** Kodekan bit (MSB dahulu) ke base32 Crockford huruf kecil (C21), `len` karakter. */
export function crockford(bytes: Uint8Array, len: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < len) {
      bits -= 5;
      out += PID_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
    if (out.length >= len) break;
  }
  return out;
}

/** Pid acak kriptografis `p-xxxxxxxxxx`. */
export function randomPid(): string {
  // 256 habis dibagi 32, jadi `byte & 31` seragam.
  const bytes = randomBytes(PID_RANDOM_LENGTH);
  let s = "";
  for (const b of bytes) s += PID_ALPHABET[b & 31];
  return PID_GENERATED_PREFIX + s;
}

/** Pid berbenih deterministik untuk urutan ke-`ordinal`. */
export function seededPid(seed: string, ordinal: number): string {
  const digest = createHash("sha256").update(`${seed}:${ordinal}`).digest();
  return PID_GENERATED_PREFIX + crockford(digest, PID_RANDOM_LENGTH);
}

/** Dasar pid bab menurut jenis slot (§10). */
export function chapterPidBase(sectionTypeKey: string, chapterKey: string): string {
  return sectionTypeKey === "appendix" ? `lamp-${chapterKey.toLowerCase()}` : `bab-${chapterKey.toLowerCase()}`;
}

/** Allocator yang juga dapat ditanya dan diisi pid terpakai. */
export interface TrackingPidAllocator extends PidAllocator {
  /** true bila pid sudah dipakai dokumen (aktif, pensiun, atau dialokasikan sesi ini). */
  isUsed(pid: string): boolean;
  /** Tandai pid klien sebagai terpakai agar tidak dibangkitkan ulang. */
  reserve(pid: string): void;
}

/**
 * Allocator di atas himpunan pid terpakai. CHAPTER: `hint` = dasar pid bab
 * (lihat `chapterPidBase`); SUBSECTION/BLOCK: `hint` diabaikan, pid bangkitan.
 */
export function createTrackingAllocator(used: Iterable<string>, generate: () => string): TrackingPidAllocator {
  const taken = new Set<string>(used);
  const fresh = (): string => {
    for (let i = 0; i < MAX_COLLISION_RETRIES; i++) {
      const p = generate();
      if (!taken.has(p)) return p;
    }
    throw new Error("pid allocator: collision retries exhausted");
  };
  return {
    isUsed: (pid) => taken.has(pid),
    reserve: (pid) => {
      taken.add(pid);
    },
    next(kind: StudioIdentityKind, hint: string): string {
      let pid: string;
      if (kind === "CHAPTER" && isValidPid(hint)) {
        pid = hint;
        for (let m = 2; taken.has(pid); m++) pid = `${hint}-${m}`;
        if (!isValidPid(pid)) pid = fresh();
      } else {
        pid = fresh();
      }
      taken.add(pid);
      return pid;
    },
  };
}

/** Allocator berbenih (jalur murni, KD-22): deterministik untuk benih + urutan panggilan sama. */
export function seededPidAllocator(seed: string, used: Iterable<string> = []): TrackingPidAllocator {
  let ordinal = 0;
  return createTrackingAllocator(used, () => seededPid(seed, ordinal++));
}

/**
 * Allocator acak per dokumen yang memuat SEMUA pid dokumen (termasuk pensiun)
 * dari M18. Asinkron karena harus memuat dulu (deviasi dari tanda tangan
 * I47 yang sinkron; `next` tetap sinkron sesuai T2-55). Panggil di dalam
 * transaksi dokumen (kunci advisory) agar tidak ada penulis paralel.
 */
export async function dbPidAllocator(db: StructureDb, documentId: string): Promise<TrackingPidAllocator> {
  // Swarm patch (row 109): M18 read over the store transaction.
  const rows = db.all<{ pid: string }>("SELECT pid FROM doc_identity WHERE document_id = ?", [documentId]);
  return createTrackingAllocator(
    rows.map((r) => r.pid),
    randomPid,
  );
}

/** Id baris gaya cuid (huruf kecil + digit, berawalan `c`, 25 karakter) untuk createMany bertaut. */
export function newRowId(): string {
  const bytes = randomBytes(24);
  let s = "c";
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (const b of bytes) s += alphabet[b % 36];
  return s;
}
