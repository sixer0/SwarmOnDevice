/**
 * Pagar keamanan server MCP Studio (MCP-01; pengerasan MCP-04, D-461):
 * - {@link guardedFetch}: setiap permintaan HTTP hanya ke asal `STUDIO_BASE_URL` dan pengalihan
 *   TIDAK PERNAH diikuti (rahasia tidak diteruskan ke host lain, termasuk jalur draft-check yang di CLI
 *   memakai `follow` — D-402 M-2 berlaku untuk CLI, bukan untuk MCP);
 * - {@link redactSecret}: sensor ulang nilai rahasia (juga bentuk JSON-escape, URL, base64) pada teks
 *   apa pun yang keluar (hasil alat, log);
 * - {@link checkPathLexical} + {@link resolveAllowedPath}: path baca/tulis ditolak SECARA LEKSIKAL lebih
 *   dulu (UNC `\\host\…`/`//host/…`, `\\?\`, `\\.\`, nama perangkat CON/NUL/COM1…, aliran data `x:y`,
 *   segmen berakhiran titik/spasi, `..` keluar akar) SEBELUM panggilan fs apa pun (M-2: tidak ada sesi
 *   SMB ke host luar), lalu realpath leluhur terdalam yang ada harus tetap di dalam akar (symlink/junction);
 * - {@link writeFileGuarded}: tulis berkas hanya ke path yang lolos validasi ulang tepat sebelum tulis;
 *   berkas yang ada TIDAK PERNAH ditimpa kecuali `overwrite: true`, dan saat itu cadangan
 *   `<nama>.bak-<waktu>` dibuat lebih dulu (M-1); nama berkas/folder instruksi agen ditolak;
 * - {@link virtualFs}: `FsLike` untuk `studio-report` yang membaca laporan dari memori dan MENOLAK
 *   setiap tulis kecuali satu tujuan yang diizinkan eksplisit (refresh `write`/`outPath`).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HttpFetch } from "../_http-client";
import type { FsLike } from "../studio-report";

/** Galat alat MCP dengan kode stabil (dipetakan ke hasil `isError`). */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: {
      httpStatus?: number;
      correlationId?: string;
      details?: unknown;
      step?: string;
      pointer?: string;
      progress?: unknown;
      /** MCP-D3 F-1: `message` adalah teks galat asal server (dipindah ke blok data tak tepercaya). */
      serverMessage?: boolean;
      /** MCP-D3 F-1: `details` memuat isi asal server walau galat dibuat MCP (mis. pemilik dokumen, isu importer). */
      untrusted?: boolean;
    } = {},
  ) {
    super(message);
  }
}

/** Fetch yang membatasi tujuan ke `origin` dan memaksa `redirect: "manual"`. */
export function guardedFetch(origin: string, inner: HttpFetch): HttpFetch {
  return async (url, init) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error("URL permintaan tidak sah");
    }
    if (target.origin !== origin) throw new Error(`permintaan ke ${target.origin} ditolak: server MCP hanya menghubungi ${origin} (STUDIO_BASE_URL)`);
    return inner(url, { ...init, redirect: "manual" });
  };
}

/**
 * Ganti setiap kemunculan rahasia dengan penanda; rahasia kosong/pendek (< 4) tidak disensor (tidak ada
 * nilai). L-2: bentuk JSON-escape, URL-encode, dan base64 ikut disensor (pertahanan berlapis).
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 4) return text;
  const forms = new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret, "utf8").toString("base64")]);
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) if (f.length >= 4) out = out.split(f).join("[RAHASIA-DISENSOR]");
  return out;
}

/** Operasi fs nyata yang dipakai alat (dapat disuntik uji untuk membuktikan nol tulis / nol panggilan). */
export interface NodeFs {
  realpath(p: string): string;
  exists(p: string): boolean;
  stat(p: string): { isFile: boolean; isDirectory: boolean; size: number };
  readFile(p: string): Buffer;
  /** Tulis eksklusif (`wx`); EEXIST dilempar dengan `code`. */
  writeFileExclusive(p: string, data: Uint8Array): void;
  /** Tulis atomik (berkas sementara eksklusif + rename); dipakai HANYA sesudah cadangan dibuat. */
  writeFileAtomic(p: string, data: Uint8Array): void;
  /** Salin eksklusif (gagal EEXIST bila tujuan ada); untuk cadangan. */
  copyFileExclusive(src: string, dest: string): void;
  mkdirp(p: string): void;
}

export const REAL_NODE_FS: NodeFs = {
  realpath: (p) => fs.realpathSync.native(p),
  exists: (p) => fs.existsSync(p),
  stat: (p) => {
    const s = fs.statSync(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  },
  readFile: (p) => fs.readFileSync(p),
  writeFileExclusive: (p, d) => fs.writeFileSync(p, d, { flag: "wx" }),
  writeFileAtomic: (p, d) => {
    const tmp = `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, d, { flag: "wx" });
    try {
      fs.renameSync(tmp, p);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  },
  copyFileExclusive: (src, dest) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL),
  mkdirp: (p) => void fs.mkdirSync(p, { recursive: true }),
};

const isWin = process.platform === "win32";
const norm = (p: string): string => (isWin ? p.toLowerCase() : p);

function isInside(child: string, root: string): boolean {
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath leluhur terdalam yang ada + sisa segmen (untuk path yang belum ada). */
function realpathDeep(p: string, nfs: NodeFs): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    if (nfs.exists(cur)) return path.join(nfs.realpath(cur), ...rest.reverse());
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/** Nama perangkat cadangan Windows (dengan ekstensi apa pun, tanpa peka huruf; termasuk digit superskrip). */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * M-2/L-3: validasi leksikal TANPA panggilan fs apa pun. Menolak NUL, path relatif, UNC (`\\host\…`,
 * `//host/…`), awalan perangkat (`\\?\`, `\\.\`, `\??\`), titik dua selain sesudah huruf drive (aliran
 * data alternatif `x:evil.md`), nama perangkat cadangan, dan segmen berakhiran titik/spasi (Windows
 * membuangnya diam-diam sehingga `CLAUDE.md.` = `CLAUDE.md`). Mengembalikan path ter-resolve.
 */
export function checkPathLexical(raw: string): string {
  const shown = raw.slice(0, 200);
  if (raw.includes("\u0000")) throw new McpToolError("PATH_INVALID", "path memuat byte NUL");
  if (/^[\\/]{2}/.test(raw) || /^\\\?\?\\/.test(raw)) {
    throw new McpToolError("PATH_INVALID", `path UNC/perangkat ditolak (diberikan "${shown}"): hanya path lokal di dalam STUDIO_MCP_FILE_ROOTS`);
  }
  if (!path.isAbsolute(raw)) throw new McpToolError("PATH_INVALID", `path harus absolut (diberikan "${shown}")`);
  const body = /^[A-Za-z]:/.test(raw) ? raw.slice(2) : raw;
  if (body.includes(":")) throw new McpToolError("PATH_INVALID", `path memuat ":" di luar huruf drive (aliran data alternatif ditolak; diberikan "${shown}")`);
  for (const seg of body.split(/[\\/]+/)) {
    if (seg === "" || seg === "." || seg === "..") continue;
    if (/[. ]$/.test(seg)) throw new McpToolError("PATH_INVALID", `segmen path "${seg.slice(0, 80)}" berakhiran titik atau spasi (ditolak)`);
    if (DEVICE_NAME_RE.test(seg.trim())) throw new McpToolError("PATH_INVALID", `nama perangkat cadangan Windows "${seg.slice(0, 80)}" ditolak`);
  }
  return path.resolve(raw);
}

/** M-1(b): berkas/folder instruksi agen tidak pernah boleh ditulis lewat MCP (walau `overwrite: true`). */
const PROTECTED_BASENAMES: ReadonlySet<string> = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", "soul.md", "copilot-instructions.md", "memory.md"]);
// Swarm patch (row 107, row 11 L6): `.opencode` and `.swarm` added (defence in depth).
const PROTECTED_DIRS: ReadonlySet<string> = new Set([".claude", ".github", ".cursor", ".hermes", ".codex", ".gemini", ".vscode", ".git", ".opencode", ".swarm"]);
const PROTECTED_SUFFIX_RE = /\.(agent|instructions|prompt|chatmode)\.md$/i;

function assertNotProtected(resolved: string, isDir = false): void {
  const base = path.basename(resolved).toLowerCase();
  const dirs = path.dirname(resolved).split(/[\\/]+/).map((s) => s.toLowerCase());
  // SEC-FIX L-2: tujuan folder (`write-dir`) yang ITU SENDIRI bernama folder instruksi (`<akar>/.claude`) juga ditolak.
  if (PROTECTED_BASENAMES.has(base) || PROTECTED_SUFFIX_RE.test(base) || dirs.some((d) => PROTECTED_DIRS.has(d)) || (isDir && PROTECTED_DIRS.has(base))) {
    throw new McpToolError("PATH_PROTECTED", `${resolved} adalah berkas/folder instruksi agen; server MCP tidak pernah menulisnya. Pakai folder kerja khusus di dalam STUDIO_MCP_FILE_ROOTS`);
  }
}

// Swarm patch (1.2.6 row 50b, W-13 N-167): fourth purpose `read-asset` (PNG/JPEG upload by path).
export type PathPurpose = "read-report" | "write-report" | "write-dir" | "read-asset";

const REPORT_EXT = new Set([".md", ".markdown", ".txt"]);
const ASSET_EXT = new Set([".png", ".jpg", ".jpeg"]);

/**
 * Validasi path dari argumen alat. Urutan: leksikal ({@link checkPathLexical}) -> di dalam akar secara
 * leksikal -> (tulis) bukan berkas instruksi -> BARU fs: realpath harus tetap di dalam akar.
 * `read-report`: berkas ada, ekstensi .md/.markdown/.txt, ukuran <= `maxBytes`. `write-report`:
 * ekstensi .md/.markdown, folder induk ada. `write-dir`: folder (boleh belum ada).
 * `read-asset` (row 50b): ekstensi .png/.jpg/.jpeg, berkas biasa, ukuran <= `maxBytes` dari stat SEBELUM
 * dibaca (`ASSET_TOO_LARGE`); mengembalikan path NYATA (symlink terselesaikan) agar pembaca membuka
 * berkas yang sama dengan yang diperiksa (01f §3.3 R7). Jenis isi tetap diputuskan dekoder, bukan ekstensi.
 */
export function resolveAllowedPath(raw: string, roots: readonly string[], purpose: PathPurpose, nfs: NodeFs, maxBytes = Infinity): string {
  const resolved = checkPathLexical(raw);
  const outside = () => new McpToolError("PATH_OUTSIDE_ROOTS", `path ${resolved} di luar akar yang diizinkan (STUDIO_MCP_FILE_ROOTS: ${roots.join(path.delimiter)})`);
  if (!roots.some((r) => isInside(resolved, path.resolve(r)))) throw outside();
  const reads = purpose === "read-report" || purpose === "read-asset";
  if (!reads) assertNotProtected(resolved, purpose === "write-dir");
  const ext = path.extname(resolved).toLowerCase();
  if (purpose === "read-report" && !REPORT_EXT.has(ext)) throw new McpToolError("PATH_INVALID", `hanya berkas .md, .markdown, atau .txt yang dapat dibaca (diberikan "${path.basename(resolved)}")`);
  if (purpose === "read-asset" && !ASSET_EXT.has(ext)) throw new McpToolError("PATH_INVALID", `hanya berkas .png, .jpg, atau .jpeg yang dapat diunggah (diberikan "${path.basename(resolved)}")`);
  if (purpose === "write-report" && ext !== ".md" && ext !== ".markdown") throw new McpToolError("PATH_INVALID", `tujuan tulis laporan harus berekstensi .md (diberikan "${path.basename(resolved)}")`);
  // Sejak titik ini fs boleh disentuh: path lokal di dalam akar secara leksikal.
  const real = realpathDeep(resolved, nfs);
  const realRoots = roots.map((r) => (nfs.exists(r) ? nfs.realpath(r) : r));
  if (!realRoots.some((r) => isInside(real, r))) throw outside();
  if (!reads) assertNotProtected(real, purpose === "write-dir");
  if (purpose === "read-asset") {
    if (!nfs.exists(real)) throw new McpToolError("FILE_UNREADABLE", `berkas ${resolved} tidak ada`);
    const st = nfs.stat(real);
    if (!st.isFile) throw new McpToolError("FILE_UNREADABLE", `${resolved} bukan berkas biasa`);
    if (st.size > maxBytes) throw new McpToolError("ASSET_TOO_LARGE", `berkas ${resolved} ${st.size} B melebihi batas ${maxBytes} B`, { httpStatus: 413 });
    return real;
  }
  if (purpose === "read-report") {
    if (!nfs.exists(resolved)) throw new McpToolError("FILE_UNREADABLE", `berkas ${resolved} tidak ada`);
    const st = nfs.stat(resolved);
    if (!st.isFile) throw new McpToolError("FILE_UNREADABLE", `${resolved} bukan berkas`);
    if (st.size > maxBytes) throw new McpToolError("PAYLOAD_TOO_LARGE", `berkas ${resolved} ${st.size} B melebihi batas ${maxBytes} B`);
  } else if (purpose === "write-report") {
    const dir = path.dirname(resolved);
    if (!nfs.exists(dir) || !nfs.stat(dir).isDirectory) throw new McpToolError("PATH_INVALID", `folder ${dir} tidak ada`);
    if (nfs.exists(resolved) && !nfs.stat(resolved).isFile) throw new McpToolError("PATH_INVALID", `${resolved} bukan berkas`);
  } else if (nfs.exists(resolved) && !nfs.stat(resolved).isDirectory) {
    throw new McpToolError("PATH_INVALID", `${resolved} bukan folder`);
  }
  return resolved;
}

/** M-1: tulis berkas hanya bila `STUDIO_MCP_FILE_ROOTS` diisi eksplisit. */
export function assertFileWriteEnabled(enabled: boolean, what: string): void {
  if (!enabled) {
    throw new McpToolError(
      "FILE_WRITE_DISABLED",
      `${what} menulis berkas, tetapi STUDIO_MCP_FILE_ROOTS tidak diisi pada proses server MCP (tanpa bawaan cwd). Isi env itu dengan folder kerja khusus yang kosong, atau baca hasil dari medan markdown/structuredContent`,
    );
  }
}

/**
 * SEC-FIX L-2: folder unduhan dari argumen alat (`downloadDir`), divalidasi SEBELUM jaringan dan sebelum folder
 * dibuat: di dalam akar, bukan UNC/ADS/perangkat, dan bukan folder instruksi (`.claude`, `.git`, ...), baik
 * sebagai induk maupun sebagai nama folder itu sendiri. Satu pembantu untuk semua alat yang mengunduh.
 */
export function resolveDownloadDir(raw: string, roots: readonly string[], nfs: NodeFs): string {
  return resolveAllowedPath(raw, roots, "write-dir", nfs);
}

/**
 * SEC-FIX L-2: validasi ULANG folder unduhan tepat sebelum `mkdirp` (jeda jaringan di antaranya membuka jendela
 * penukaran junction), lalu buat foldernya. Gagal buat -> OUT_UNWRITABLE.
 */
export function prepareDownloadDir(dir: string, roots: readonly string[], nfs: NodeFs): void {
  resolveDownloadDir(dir, roots, nfs);
  try {
    nfs.mkdirp(dir);
  } catch (e) {
    throw new McpToolError("OUT_UNWRITABLE", `tidak dapat membuat folder ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Cap waktu cadangan: `YYYYMMDDTHHMMSSZ` (UTC). */
export function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface GuardedWriteResult {
  written: string;
  /** Cadangan berkas lama (hanya bila berkas sudah ada dan `overwrite: true`). */
  backup: string | null;
}

/**
 * M-1 + L-3: tulis `data` ke `target` (sudah lolos {@link resolveAllowedPath}). Validasi ULANG tepat
 * sebelum tulis (menyempitkan jendela TOCTOU penukaran junction). Berkas belum ada -> tulis eksklusif
 * (`wx`). Berkas ada -> OUT_EXISTS kecuali `overwrite`; dengan `overwrite` cadangan `<nama>.bak-<waktu>`
 * (salin eksklusif) dibuat dulu, baru tulis atomik. `isSame` (opsional): isi sama -> tidak ditulis ulang.
 */
export function writeFileGuarded(
  target: string,
  data: Uint8Array,
  o: { roots: readonly string[]; purpose: "write-report" | "write-file"; overwrite: boolean; nfs: NodeFs; now: () => number; log?: string[]; isSame?: (existing: Buffer) => boolean },
): GuardedWriteResult & { unchanged: boolean } {
  const nfs = o.nfs;
  if (o.purpose === "write-report") resolveAllowedPath(target, o.roots, "write-report", nfs);
  else {
    resolveAllowedPath(path.dirname(target), o.roots, "write-dir", nfs);
    checkPathLexical(target);
    assertNotProtected(target);
  }
  const existsNow = nfs.exists(target);
  if (existsNow && o.isSame && o.isSame(nfs.readFile(target))) return { written: target, backup: null, unchanged: true };
  if (existsNow && !o.overwrite) {
    throw new McpToolError("OUT_EXISTS", `${target} sudah ada; tidak ditimpa. Pakai nama berkas baru, atau overwrite: true (cadangan <nama>.bak-<waktu> dibuat otomatis lebih dulu)`);
  }
  let backup: string | null = null;
  if (existsNow) {
    const stamp = backupStamp(o.now());
    for (let i = 0; i < 100 && backup === null; i++) {
      const cand = `${target}.bak-${stamp}${i === 0 ? "" : `-${i + 1}`}`;
      try {
        nfs.copyFileExclusive(target, cand);
        backup = cand;
        o.log?.push(`cadangan ${cand}`);
      } catch (e) {
        if (!(isErrno(e) && e.code === "EEXIST")) throw new McpToolError("OUT_UNWRITABLE", `tidak dapat membuat cadangan ${cand}: ${errMsg(e)}; berkas tidak ditimpa`);
      }
    }
    if (backup === null) throw new McpToolError("OUT_UNWRITABLE", `tidak dapat membuat cadangan untuk ${target}; berkas tidak ditimpa`);
    o.log?.push(`tulis ${target}`);
    try {
      nfs.writeFileAtomic(target, data);
    } catch (e) {
      throw new McpToolError("OUT_UNWRITABLE", `tidak dapat menulis ${target}: ${errMsg(e)} (cadangan ${backup} tetap ada)`);
    }
    return { written: target, backup, unchanged: false };
  }
  o.log?.push(`tulis ${target}`);
  try {
    nfs.writeFileExclusive(target, data);
  } catch (e) {
    if (isErrno(e) && e.code === "EEXIST") throw new McpToolError("OUT_EXISTS", `${target} muncul saat akan ditulis; tidak ditimpa`);
    throw new McpToolError("OUT_UNWRITABLE", `tidak dapat menulis ${target}: ${errMsg(e)}`);
  }
  return { written: target, backup: null, unchanged: false };
}

function isErrno(e: unknown): e is { code: unknown } {
  return e !== null && typeof e === "object" && "code" in e;
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface VirtualFsLog {
  /** Setiap percobaan tulis (diizinkan atau ditolak), untuk uji dan audit. */
  writes: string[];
}

/**
 * `FsLike` untuk `studio-report`: baca HANYA dari `files` (memori); setiap tulis ditolak kecuali
 * `writeFileText` ke `allowTextWrite` (refresh), yang diteruskan ke `writeText` (penulis berpagar).
 * `existsSync` hanya melaporkan berkas virtual.
 */
export function virtualFs(files: ReadonlyMap<string, Buffer>, opts: { allowTextWrite?: string | null; writeText?: (p: string, d: string) => void } = {}, log: VirtualFsLog = { writes: [] }): FsLike {
  const deny = (op: string, p: string): never => {
    log.writes.push(`ditolak ${op} ${p}`);
    throw new McpToolError("WRITE_NOT_ALLOWED", `server MCP tidak menulis berkas (${op} ${path.basename(p)} ditolak)`);
  };
  const read = (p: string): Buffer => {
    const b = files.get(p);
    if (b === undefined) throw Object.assign(new Error(`berkas virtual ${p} tidak ada`), { code: "ENOENT" });
    return b;
  };
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => read(p).toString("utf8"),
    readFileSyncBuffer: (p) => read(p),
    appendFileSync: (p) => deny("append", p),
    mkdirSync: (p) => deny("mkdir", p),
    writeFileSync: (p) => deny("write", p),
    writeFileText: (p, d) => {
      const allowed = opts.allowTextWrite ?? null;
      if (allowed === null || opts.writeText === undefined || norm(path.resolve(p)) !== norm(allowed)) return deny("writeText", p);
      opts.writeText(allowed, d);
    },
  };
}
