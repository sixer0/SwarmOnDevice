/**
 * IMPL-W (D-521/D-522): jalur tulis minimal. Agen hanya mengirim ISI tersusun (judul bagian + blok: string =
 * paragraf, larik baris = tabel); mesin di modul ini menyusun teks Markdown laporan kerja yang SUDAH dipahami
 * konverter `studio-report` (md-report), lalu alat `studio_write` mengirimnya lewat jalur submit yang sama
 * (semua aturan keamanan D-480..D-493 berlaku apa adanya). Murni: tanpa I/O, tanpa jaringan.
 *
 * Perbaikan otomatis yang aman (setiap perbaikan = satu peringatan): judul bagian dipetakan ke bab kontrak lewat
 * alias registri + alias tambahan + kecocokan kata utuh; tabel ber-kolom status dikenali sebagai tabel butir kerja
 * (kunci stabil dibangkitkan bila kosong, nama kolom dan status butir dinormalkan); record diisi (Owner dari agentId,
 * Status bawaan draft, ReportedAt hari ini). Ditolak hanya yang tidak dapat disimpulkan aman: bab wajib tanpa isi.
 */
import { createHash } from "node:crypto";
import { getContractKindDef } from "../../../src/lib/studio/registry/contracts";
import { CONTRACT_ACTOR_PATTERN, CONTRACT_KEY_PATTERN } from "../../../src/lib/studio/contract/env";
import { mdReportRules, MD_REPORT_DEFAULT_KIND } from "../../../src/lib/studio/services/draft/md-report";
import { normalizeHeading } from "../../../src/lib/studio/services/import/contract/parse";
import { McpToolError } from "./safety";
import type { ToolWarning } from "./tool-kit";

// ── Bentuk masukan ──────────────────────────────────────────────────────

export type Cell = string | number;
export type Rows = Cell[][];
export interface ChartInput {
  type?: string;
  categories: Cell[];
  series: Array<{ name: string; values: Array<number | null> }>;
  caption?: string;
  source?: string;
  unit?: string;
}
export interface RefInput {
  rel: string;
  documentId: string;
  pid?: string;
  revision?: string | number;
}
export type Block = string | Rows | { table: Rows; caption?: string; source?: string; unit?: string } | { chart: ChartInput } | { list: string[]; ordered?: boolean } | { subheading: string } | { ref: RefInput };
export interface SectionInput {
  heading: string;
  blocks: Block[];
}

export const isRows = (b: unknown): b is Rows => Array.isArray(b) && b.every((r) => Array.isArray(r));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ── Sanitasi teks (struktur Markdown milik mesin, bukan isi) ────────────

/** Garis horizontal (sama dengan `HR_LINE_RE` serializer md-report). */
const HR_LINE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** Paragraf yang dibaca importer sebagai caption/sumber (sama dengan `CAPTIONISH_RE` md-report). */
const CAPTIONISH_RE = /^(?:\*{1,2}|_{1,2})?(?:Tabel|Table|Gambar|Figure|Fig|Sumber|Source)\b/i;
/**
 * Awal baris berbentuk `Kunci: nilai` (lebih luas dari `KV_RE` generator dan pembaca kunci alat `agentId:`/`basis:`/
 * `mission:`): nilai kosong dan awalan daftar/kutipan ikut, agar tidak satu pun baris paragraf menjadi medan record.
 */
const KEYISH_RE = /^(?:[-*>+]\s*)*\*{0,2}[A-Za-zÀ-ÿ_][\wÀ-ÿ /.-]{0,40}?\*{0,2}\s*:/;

/**
 * M-1 (review 13, D-529): satu aturan escape awal baris setara `guardLineStart` serializer server (`md-report.ts`), plus
 * pagar kode, penanda konflik, `Kunci:` yang lebih luas, dan SETIAP `|` (findTables mengenali tabel tanpa `|` awal).
 * Masukan: satu baris teks (spasi awal dibuang: indentasi 4 spasi = blok kode).
 */
export function guardLine(raw: string): string {
  let out = raw.replace(/^\s+/, "").replace(/\s+$/, "");
  out = out.replace(/(?<!\\)\|/g, "\\|");
  // R-1 (siklus 2): komentar HTML dibuang konverter (menelan teks) -> setiap `<!--` dinetralkan.
  out = out.replace(/<!--/g, "<\\!--");
  // `:` di awal = baris pemisah tabel (`:--`) -> di-escape seperti penanda blok lain.
  if (/^[#>+=|:-]/.test(out) || HR_LINE_RE.test(out) || /^(?:`{3,}|~{3,}|<{7})/.test(out)) out = `\\${out}`;
  else {
    const m = /^(\d{1,9})([.)])/.exec(out);
    if (m) out = `${m[1]}\\${m[2]}${out.slice(m[0].length)}`;
  }
  const kv = KEYISH_RE.exec(out);
  if (kv) {
    const k = kv[0].length - 1;
    out = `${out.slice(0, k)}\\${out.slice(k)}`;
  }
  if (CAPTIONISH_RE.test(out)) out = out.replace(/(?<!\\)([.:])/g, "\\$1");
  return out;
}

/**
 * Satu paragraf: setiap baris lewat {@link guardLine}; peringatan bila ada baris yang berubah. IMPL-W3 butir 13: baris
 * tunggal (wrap keras) digabung dengan spasi; baris kosong memisah paragraf (dipertahankan sebagai baris kosong).
 */
export function paragraphLines(s: string, warn: (w: ToolWarning) => void, where: string): string[] {
  const lines = s
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, " ").trim())
    .filter((p) => p !== "")
    .flatMap((p, i) => (i === 0 ? [p] : ["", p]));
  const out = lines.map(guardLine);
  // Escape `\:` / `\.` tidak terlihat di hasil (tanpa peringatan); peringatan hanya bila awal baris atau `|` berubah.
  if (out.some((l, i) => l.replace(/\\([:.])/g, "$1") !== lines[i].trim())) warn({ code: "TEXT_ESCAPED", message: `${where}: baris yang menyerupai struktur (judul, tabel, pagar, daftar, Kunci: nilai) di dalam teks di-escape agar tetap teks` });
  return out;
}

export function cellText(c: unknown): string {
  return String(c ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\\?\|/g, "\\|")
    .trim();
}

export function tableLines(rows: Rows, warn: (w: ToolWarning) => void, where: string): string[] {
  const width = Math.max(1, rows[0]?.length ?? 1);
  let padded = false;
  const norm = rows.map((r) => {
    if (r.length === width) return r;
    padded = true;
    return r.length > width ? r.slice(0, width) : [...r, ...Array.from({ length: width - r.length }, () => "")];
  });
  if (padded) warn({ code: "TABLE_ROW_PADDED", message: `${where}: baris tabel disamakan lebarnya dengan baris judul (${width} kolom)` });
  const line = (r: Cell[]) => `| ${r.map(cellText).join(" | ")} |`;
  return [line(norm[0]), `|${" --- |".repeat(width)}`, ...norm.slice(1).map(line)];
}

// ── Judul bagian -> bab kontrak laporan kerja ───────────────────────────

/** Alias tambahan (Inggris/Indonesia umum) di atas alias registri; nilai = kunci bab outline. */
const EXTRA_HEADINGS: Readonly<Record<string, string>> = {
  summary: "1", "executive summary": "1", ikhtisar: "1", overview: "1", abstrak: "1", "ringkasan pekerjaan": "1",
  details: "2", "work done": "2", work: "2", pekerjaan: "2", "rincian pekerjaan": "2", "uraian kerja": "2", tasks: "2", "butir kerja": "2", "work items": "2", kegiatan: "2", aktivitas: "2", progress: "2", kemajuan: "2",
  evidence: "3", proof: "3", artifacts: "3", outputs: "3", "hasil uji": "3", tests: "3", testing: "3", pengujian: "3", validasi: "3", validation: "3",
  issues: "4", "open issues": "4", risks: "4", risiko: "4", kendala: "4", masalah: "4", hambatan: "4", blockers: "4", problems: "4",
  "next steps": "5", next: "5", rencana: "5", "rencana berikut": "5", "tindak lanjut": "5", "follow up": "5", "follow-up": "5", plan: "5", "langkah selanjutnya": "5", selanjutnya: "5",
};

export interface ChapterMap {
  /** kunci bab -> judul outline kanonik. */
  titles: Map<string, string>;
  required: string[];
  /** alias ternormalisasi -> kunci bab. */
  aliases: Map<string, string>;
}

let chapterMapCache: ChapterMap | null = null;
export function workReportChapters(): ChapterMap {
  if (chapterMapCache !== null) return chapterMapCache;
  const def = getContractKindDef(MD_REPORT_DEFAULT_KIND);
  if (!def) throw new McpToolError("INTERNAL_ERROR", "registri kontrak laporan kerja tidak tersedia");
  const titles = new Map(def.outline.map((o) => [o.chapterKey, o.title] as [string, string]));
  const aliases = new Map<string, string>();
  for (const c of mdReportRules().chapters) for (const t of c.titles) aliases.set(normalizeHeading(t), c.key);
  for (const [t, k] of Object.entries(EXTRA_HEADINGS)) if (!aliases.has(normalizeHeading(t))) aliases.set(normalizeHeading(t), k);
  chapterMapCache = { titles, required: def.outline.filter((o) => o.required).map((o) => o.chapterKey), aliases };
  return chapterMapCache;
}

const stripNumber = (h: string) => h.replace(/^\s*(?:bab|chapter|bagian)?\s*[([]?(?:\d{1,3}|[A-Za-z])[.)\]:]\s+/i, "").trim();

/**
 * Kunci bab untuk satu judul: alias persis (registri/tambahan) -> tanpa perubahan judul; kata utuh alias di dalam
 * judul dan hanya satu bab yang cocok -> judul diganti judul outline (peringatan). null = bab tambahan.
 */
export function mapHeading(heading: string, m: ChapterMap): { key: string | null; heading: string; how: "exact" | "alias" | "words" | "none" } {
  const bare = stripNumber(heading);
  const n = normalizeHeading(bare);
  const exact = m.aliases.get(n);
  if (exact !== undefined) {
    const viaExtra = EXTRA_HEADINGS[bare.toLowerCase()] !== undefined && !mdReportRules().chapters.some((c) => c.titles.includes(n));
    return viaExtra ? { key: exact, heading: m.titles.get(exact) ?? bare, how: "alias" } : { key: exact, heading: bare, how: "exact" };
  }
  const words = ` ${n.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const hits = new Set<string>();
  for (const [alias, key] of m.aliases) {
    const a = alias.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
    if (a.length >= 4 && words.includes(` ${a} `)) hits.add(key);
  }
  if (hits.size === 1) {
    const key = [...hits][0];
    return { key, heading: m.titles.get(key) ?? bare, how: "words" };
  }
  return { key: null, heading: bare, how: "none" };
}

// ── Tabel butir kerja ───────────────────────────────────────────────────

const COLUMN_ALIASES: Readonly<Record<string, "key" | "judul" | "status" | "owner" | "bukti">> = {
  key: "key", kunci: "key", id: "key", kode: "key", code: "key", no: "key", "#": "key", kartu: "key", card: "key", "item id": "key",
  judul: "judul", title: "judul", butir: "judul", item: "judul", task: "judul", tugas: "judul", pekerjaan: "judul", nama: "judul", name: "judul", kegiatan: "judul", deskripsi: "judul", description: "judul",
  status: "status", state: "status", keadaan: "status", progress: "status",
  owner: "owner", pemilik: "owner", assignee: "owner", agen: "owner", agent: "owner", pic: "owner", "penanggung jawab": "owner",
  bukti: "bukti", evidence: "bukti", artefak: "bukti", artifact: "bukti", berkas: "bukti", file: "bukti",
};

const ITEM_STATUS_ALIASES: Readonly<Record<string, string>> = {
  done: "done", selesai: "done", complete: "done", completed: "done", finished: "done", ok: "done", beres: "done", tuntas: "done", sudah: "done", lulus: "done", pass: "done", passed: "done",
  running: "running", berjalan: "running", "in progress": "running", "in-progress": "running", ongoing: "running", sedang: "running", proses: "running", wip: "running", dikerjakan: "running",
  todo: "todo", "to do": "todo", belum: "todo", pending: "todo", open: "todo", sisa: "todo", planned: "todo",
  ready: "ready", siap: "ready",
  review: "review", ditinjau: "review", tinjau: "review",
  blocked: "blocked", terhambat: "blocked", blokir: "blocked", macet: "blocked",
  cancelled: "cancelled", canceled: "cancelled", batal: "cancelled", dibatalkan: "cancelled",
  // IMPL-W3 butir 7: padanan Indonesia tambahan (kunci dinormalkan: huruf kecil, - _ menjadi spasi).
  terblokir: "blocked", diblokir: "blocked", tertahan: "blocked",
  "perlu tinjauan": "review", "perlu review": "review", "perlu ditinjau": "review", "menunggu tinjauan": "review", "menunggu review": "review", "needs review": "review",
  "belum mulai": "todo", "belum dimulai": "todo", "akan dikerjakan": "todo",
  "dalam proses": "running", "sedang berjalan": "running", "sedang dikerjakan": "running", "on going": "running",
  // IMPL-W5 E5 (D-557, r6: sel "terblokir" di studio_edit -> RECORD_ELEMENTS_DROPPED): padanan tambahan.
  aktif: "running", menunggu: "todo", "butuh tinjauan": "review", "butuh review": "review", tinjauan: "review", "dalam tinjauan": "review",
};

/** Kode status butir registri (CI-01..CI-07). */
export const ITEM_STATUS_CODES: ReadonlySet<string> = new Set(["todo", "ready", "running", "review", "done", "blocked", "cancelled"]);

/** Kunci alias status: huruf kecil, `-`/`_` menjadi spasi, spasi dirapatkan. */
const statusKey = (s: string): string => s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
const lookupStatus = (table: Readonly<Record<string, string>>, raw: string): string | undefined => table[raw.trim().toLowerCase()] ?? table[statusKey(raw)];
/** IMPL-W5 E5: status butir sehari-hari (ID/EN, huruf besar/kecil bebas) -> kode registri; undefined = tak terpetakan. */
export const itemStatusOf = (raw: string): string | undefined => (ITEM_STATUS_CODES.has(raw.trim()) ? raw.trim() : lookupStatus(ITEM_STATUS_ALIASES, raw));

const KEY_RE = new RegExp(CONTRACT_KEY_PATTERN);
const ACTOR_RE = new RegExp(CONTRACT_ACTOR_PATTERN);

/** Kunci butir stabil dari judul (sama selama judul sama): `K-` + 8 heksa sha256. */
export function stableKey(seed: string): string {
  return `K-${createHash("sha256").update(seed.trim().toLowerCase(), "utf8").digest("hex").slice(0, 8)}`;
}

/**
 * Tabel ber-kolom status (+ kunci atau judul) = tabel butir kerja: nama kolom dinormalkan ke nama yang dibaca
 * konverter, kolom `key` disisipkan bila tidak ada, kunci kosong/tak sah dibangkitkan/dirapikan, status butir
 * dipetakan ke kode registri. Tabel lain dikembalikan apa adanya.
 */
export function repairItemTable(rows: Rows, warn: (w: ToolWarning) => void, where: string, used: Set<string>, prevStatus?: ReadonlyMap<string, string>): Rows {
  if (rows.length < 2) return rows;
  const roles = rows[0].map((h) => COLUMN_ALIASES[String(h).trim().toLowerCase()] ?? null);
  const statusIdx = roles.indexOf("status");
  let keyIdx = roles.indexOf("key");
  const titleIdx = roles.indexOf("judul");
  if (statusIdx < 0 || (keyIdx < 0 && titleIdx < 0)) return rows;
  let out: Rows = rows.map((r) => [...r]);
  const renamed = rows[0].filter((h, i) => roles[i] !== null && String(h).trim().toLowerCase() !== roles[i]);
  out[0] = out[0].map((h, i) => roles[i] ?? h);
  if (renamed.length > 0) warn({ code: "ITEM_COLUMNS_RENAMED", message: `${where}: kolom tabel butir dinormalkan (${renamed.map(String).join(", ")})` });
  if (keyIdx < 0) {
    out = out.map((r, i) => [i === 0 ? "key" : "", ...r]);
    keyIdx = 0;
    warn({ code: "ITEM_KEY_COLUMN_ADDED", message: `${where}: tabel butir tanpa kolom kunci; kolom key ditambahkan dengan kunci stabil dari judul` });
  }
  const t = titleIdx < 0 ? -1 : titleIdx + (roles.indexOf("key") < 0 ? 1 : 0);
  const s = statusIdx + (roles.indexOf("key") < 0 ? 1 : 0);
  const generated: string[] = [];
  const fixed: string[] = [];
  const unknown: string[] = [];
  const kept: string[] = [];
  for (let i = 1; i < out.length; i++) {
    const r = out[i];
    let key = String(r[keyIdx] ?? "").trim();
    if (key !== "" && !KEY_RE.test(key)) {
      const repaired = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
      if (repaired !== "" && KEY_RE.test(repaired)) fixed.push(`${key} -> ${repaired}`);
      key = KEY_RE.test(repaired) ? repaired : "";
    }
    if (key === "") {
      const seed = t >= 0 && String(r[t] ?? "").trim() !== "" ? String(r[t]) : r.filter((_, j) => j !== keyIdx && j !== s).join(" ");
      key = stableKey(seed === "" ? `${where}#${i}` : seed);
      generated.push(key);
    }
    let k = key;
    for (let n = 2; used.has(k.toLowerCase()); n++) k = `${key}-${n}`;
    used.add(k.toLowerCase());
    r[keyIdx] = k;
    const st = itemStatusOf(String(r[s] ?? ""));
    const prev = prevStatus?.get(k.toLowerCase());
    if (st !== undefined) r[s] = st;
    else if (prev !== undefined) {
      // IMPL-W5 E5: butir yang sudah ada di record tidak pernah hilang karena status tak terpetakan; status lama dipakai.
      kept.push(`${k}: ${String(r[s] ?? "")}`);
      r[s] = prev;
    } else unknown.push(String(r[s] ?? ""));
    const ownerIdx = out[0].indexOf("owner");
    if (ownerIdx >= 0 && typeof r[ownerIdx] === "string") {
      const o = (r[ownerIdx] as string).trim().toLowerCase().replace(/\s+/g, "-");
      if (ACTOR_RE.test(o)) r[ownerIdx] = o;
    }
  }
  if (generated.length > 0) warn({ code: "ITEM_KEY_GENERATED", message: `${where}: ${generated.length} butir tanpa kunci diberi kunci stabil (${generated.slice(0, 5).join(", ")})` });
  if (fixed.length > 0) warn({ code: "ITEM_KEY_REPAIRED", message: `${where}: kunci butir dirapikan (${fixed.slice(0, 5).join("; ")})` });
  if (kept.length > 0) warn({ code: "ITEM_STATUS_KEPT", message: `${where}: status butir tidak dikenal (${kept.slice(0, 5).join(", ")}); butir tetap di record dengan status sebelumnya. Pakai done, running, ready, todo, review, blocked, cancelled` });
  if (unknown.length > 0) warn({ code: "ITEM_STATUS_UNKNOWN", message: `${where}: status butir tidak dikenal (${unknown.slice(0, 5).join(", ")}); baris tetap di teks tetapi tidak masuk record. Pakai done, running, ready, todo, review, blocked, cancelled` });
  return out;
}

/** Grafik di laporan kerja (tanpa figur) -> tabel data kategori x seri, keterangan sebagai paragraf. */
export function chartRows(c: ChartInput): Rows {
  return [["kategori", ...c.series.map((s) => s.name)], ...c.categories.map((cat, i) => [cat, ...c.series.map((s) => (s.values[i] === null || s.values[i] === undefined ? "" : s.values[i] as number))])];
}

// ── Record laporan kerja dari meta ──────────────────────────────────────

const META_RECORD_KEYS: Readonly<Record<string, "status" | "owner" | "verdict" | "initiator" | "taskRef" | "reportedAt" | "cardIds" | "title">> = {
  status: "status", owner: "owner", pemilik: "owner", "penanggung jawab": "owner", verdict: "verdict", vonis: "verdict",
  initiator: "initiator", "pemberi tugas": "initiator", taskref: "taskRef", task: "taskRef", "rujukan tugas": "taskRef", row: "taskRef",
  reportedat: "reportedAt", tanggal: "reportedAt", date: "reportedAt", "waktu lapor": "reportedAt", cardids: "cardIds", kartu: "cardIds",
  title: "title", judul: "title",
};

/** Status laporan tambahan (bahasa sehari-hari) di atas alias registri. */
const RECORD_STATUS_EXTRA: Readonly<Record<string, string>> = {
  selesai: "complete", done: "complete", finished: "complete", tuntas: "complete", lengkap: "complete",
  sebagian: "partial", parsial: "partial", terhambat: "blocked", macet: "blocked", draf: "draft", review: "needs-review", tinjau: "needs-review", "perlu review": "needs-review",
  // IMPL-W3 butir 7 (kunci dinormalkan statusKey).
  terblokir: "blocked", diblokir: "blocked", "perlu tinjauan": "needs-review", "perlu ditinjau": "needs-review", "needs review": "needs-review", "menunggu tinjauan": "needs-review",
  berjalan: "partial", "dalam proses": "partial", "sedang berjalan": "partial", "in progress": "partial", "selesai sebagian": "partial",
};

/** IMPL-W3 butir 4: vonis -> kode registri (PASS, CAUTION, FAIL, NEEDS_REVIEW); kunci dinormalkan statusKey. */
const VERDICT_ALIASES: Readonly<Record<string, string>> = {
  pass: "PASS", lulus: "PASS", ok: "PASS", berhasil: "PASS", lolos: "PASS", aman: "PASS",
  caution: "CAUTION", "lulus dengan catatan": "CAUTION", "lolos dengan catatan": "CAUTION", catatan: "CAUTION", waspada: "CAUTION", "hati hati": "CAUTION", "perlu perhatian": "CAUTION",
  fail: "FAIL", gagal: "FAIL", "tidak lulus": "FAIL", "tidak lolos": "FAIL",
  "needs review": "NEEDS_REVIEW", "perlu tinjauan": "NEEDS_REVIEW", "perlu review": "NEEDS_REVIEW", "perlu ditinjau": "NEEDS_REVIEW",
  // IMPL-W9 butir B: padanan tambahan untuk token awal ("BUTUH TINJAUAN", "passed").
  "butuh tinjauan": "NEEDS_REVIEW", "butuh review": "NEEDS_REVIEW", passed: "PASS", failed: "FAIL",
};
const VERDICT_CODES = ["PASS", "CAUTION", "FAIL", "NEEDS_REVIEW"];

/** Vonis persis (kode atau alias utuh) -> kode registri; undefined = bukan nilai utuh yang dikenal. */
function verdictExact(raw: string): string | undefined {
  const up = raw.trim().toUpperCase().replace(/[- ]/g, "_");
  return VERDICT_ALIASES[statusKey(raw)] ?? (VERDICT_CODES.includes(up) ? up : undefined);
}

/**
 * IMPL-W9 butir B (R12B "PASS (CHECK 1-8)" -> VERDICT_DROPPED): token awal nilai vonis (huruf, `_`, `-`, dipisah spasi;
 * berhenti di tanda baca/angka) dicocokkan dengan kode/alias, frasa terpanjang lebih dulu (maks 4 kata). Tanpa token awal
 * yang terpetakan -> undefined. IMPL-W10 L16-1: token awal hanya dipakai bila sisanya netral ({@link verdictRestNeutral});
 * "PASS (CHECK 1-8)" -> PASS, tetapi "PASS WITH ISSUES" / "PASS kecuali cek 3 gagal" / "lulus bersyarat" -> undefined
 * (VERDICT_DROPPED, seperti sebelum IMPL-W9).
 */
function verdictLeading(raw: string): string | undefined {
  const m = /^\s*([\p{L}_-]+(?:\s+[\p{L}_-]+)*)/u.exec(raw);
  if (m === null) return undefined;
  const lead = m[0].length - m[1].length;
  const words = [...m[1].matchAll(/[\p{L}_-]+/gu)];
  for (let n = Math.min(words.length, 4); n >= 1; n--) {
    const hit = verdictExact(words.slice(0, n).map((w) => w[0]).join(" "));
    if (hit === undefined) continue;
    const last = words[n - 1];
    // IMPL-W10 L16-1: token awal pertama yang terpetakan menentukan; sisanya harus anotasi netral.
    return verdictRestNeutral(raw.slice(lead + (last.index ?? 0) + last[0].length), hit) ? hit : undefined;
  }
  return undefined;
}

/**
 * IMPL-W10 L16-1 (review 16; review 17 #3): kata/frasa yang membuat vonis bersyarat, sebagian, atau dinegasi. Kata gagal
 * hanya diabaikan bila vonisnya sendiri FAIL ("FAIL (2 cek gagal)").
 */
const VERDICT_QUALIFIER_RE = /(?<![\p{L}])(?:kecuali|tapi|tetapi|namun|but|however|except|with issues|with conditions|with notes|dengan catatan|bersyarat|conditional|conditionally|not|tidak|belum|partial|partially|sebagian|parsial)(?![\p{L}])/iu;
const VERDICT_FAIL_WORD_RE = /(?<![\p{L}])(?:gagal|fail|failed|failing)(?![\p{L}])/iu;

/**
 * Sisa sesudah token awal vonis dianggap netral bila: kosong; hanya tanda baca (selain `?`); atau rincian yang diawali
 * `(`, `[`, `:`, `-`, `–`, `—`, `,`, `;` tanpa kata kualifikasi/negasi ({@link VERDICT_QUALIFIER_RE}), tanpa `?`, dan tanpa
 * kata gagal kecuali vonisnya FAIL. Sisa yang diawali kata/angka langsung ("PASS WITH ISSUES", "GAGAL 2 dari 8") tidak netral.
 */
function verdictRestNeutral(rest: string, verdict: string): boolean {
  const r = rest.trim();
  if (r === "") return true;
  if (r.includes("?")) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(r)) return true;
  if (!/^[([:,;\-–—]/u.test(r)) return false;
  if (VERDICT_QUALIFIER_RE.test(r)) return false;
  return verdict === "FAIL" || !VERDICT_FAIL_WORD_RE.test(r);
}
const CARD_RE = /^t_[0-9a-f]{8}$/;

const REPORTED_AT_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}| ?WIB)?)?$/;

export interface WorkReportInput {
  mission: string;
  docKey: string;
  title: string | null;
  meta: Record<string, string>;
  sections: SectionInput[];
  agentId: string | null;
  /** epoch ms (tanggal ReportedAt bawaan, zona +07:00). */
  now: number;
  /** IMPL-W5 E5: status butir tersimpan (kunci huruf kecil -> kode) untuk tulis ulang laporan yang sudah ada. */
  prevItemStatus?: ReadonlyMap<string, string>;
}

export interface BuiltReport {
  markdown: string;
  warnings: ToolWarning[];
  /** kunci bab per bagian masukan (null = bab tambahan). */
  chapters: Array<string | null>;
  /** M-1: judul `##` yang ditulis mesin (urut) untuk cek pasca-konversi. */
  headings: string[];
  /** R-1 (siklus 2): teks paragraf yang diharapkan per judul (urut), untuk mendeteksi teks yang tertelan konversi. */
  paragraphs: string[][];
  /** M-1: kunci butir (huruf kecil) dari tabel butir yang disusun mesin. */
  itemKeys: Set<string>;
  /** M-1: medan record kepala yang ditulis mesin (nama medan kontrak -> nilai). */
  recordFields: Record<string, string>;
  /**
   * IMPL-W4 butir 2: medan kepala record yang DIBERI agen di meta dan sah (nama kontrak -> nilai baris MD). Medan bawaan
   * mesin (status draft, ReportedAt hari ini, Owner = agentId) tidak termasuk. Selalu diterapkan, juga pada tulis parsial.
   */
  givenFields: Record<string, string>;
  /** IMPL-W3 butir 6: judul bab wajib yang belum berisi (kosong = lengkap). */
  missing: string[];
}

const HEADER_FIELD: Readonly<Record<string, string>> = { Status: "status", Owner: "owner", ReportedAt: "reportedAt", Verdict: "verdict", Initiator: "initiator", TaskRef: "taskRef", CardIds: "cardIds" };
function fieldsOf(header: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of header) {
    const k = l.indexOf(":");
    const f = HEADER_FIELD[l.slice(0, k)];
    if (f !== undefined) out[f] = l.slice(k + 1).trim();
  }
  return out;
}

/** Tanggal hari ini di zona WIB (+07:00), YYYY-MM-DD. */
export const wibDate = (now: number): string => new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
/** IMPL-W5 E6: jam server di zona WIB, ISO 8601 ber-zona (C37), mis. 2026-11-04T10:04:05+07:00. */
export const wibStamp = (now: number): string => `${new Date(now + 7 * 3600_000).toISOString().slice(0, 19)}+07:00`;

/**
 * IMPL-W3 butir 4: medan kepala opsional dinormalkan ke bentuk yang dibaca konverter. Tanpa ini konverter memotong nilai
 * ke token pertama (TaskRef/Initiator), atau memindah baris ke pembuka bab 1 (Verdict tak dikenal) sehingga `assertShape`
 * memberi CONTENT_INJECTION palsu. Nilai yang tidak dapat dinormalkan dibuang dengan peringatan (tidak ditebak).
 */
function normalizeOptionalFields(v: Partial<Record<string, string>>, warn: (w: ToolWarning) => void): void {
  if (v.verdict !== undefined) {
    let vd = verdictExact(v.verdict);
    if (vd === undefined) {
      vd = verdictLeading(v.verdict);
      if (vd !== undefined) warn({ code: "VERDICT_NORMALIZED", message: `meta.verdict "${v.verdict}" ditulis sebagai ${vd} (token awal; pilihan: PASS, CAUTION, FAIL, NEEDS_REVIEW)` });
    }
    if (vd === undefined) warn({ code: "VERDICT_DROPPED", message: `meta.verdict "${v.verdict}" tidak dikenal; tidak ditulis (pilihan: PASS, CAUTION, FAIL, NEEDS_REVIEW)` });
    if (vd !== undefined) v.verdict = vd;
    else delete v.verdict;
  }
  if (v.taskRef !== undefined) {
    const t = v.taskRef.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/[-.]+$/, "").slice(0, 64);
    const ok = t !== "" && KEY_RE.test(t);
    if (t !== v.taskRef) warn({ code: ok ? "TASKREF_NORMALIZED" : "TASKREF_DROPPED", message: `meta.taskRef "${v.taskRef}" ${ok ? `ditulis sebagai ${t}` : "bukan kunci; tidak ditulis"}` });
    if (ok) v.taskRef = t;
    else delete v.taskRef;
  }
  if (v.initiator !== undefined) {
    const t = v.initiator.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]+/g, "");
    const ok = ACTOR_RE.test(t);
    if (t !== v.initiator) warn({ code: ok ? "INITIATOR_NORMALIZED" : "INITIATOR_DROPPED", message: `meta.initiator "${v.initiator}" ${ok ? `ditulis sebagai ${t}` : "bukan id pelaku; tidak ditulis"}` });
    if (ok) v.initiator = t;
    else delete v.initiator;
  }
  if (v.cardIds !== undefined) {
    const all = v.cardIds.split(/[\s,;]+/).filter((x) => x !== "");
    const ok = all.filter((x) => CARD_RE.test(x));
    if (ok.length < all.length) warn({ code: "CARD_IDS_DROPPED", message: `meta.cardIds: ${all.length - ok.length} id bukan bentuk t_xxxxxxxx dan tidak ditulis` });
    if (ok.length > 0) v.cardIds = ok.join(", ");
    else delete v.cardIds;
  }
}

function recordLines(input: WorkReportInput, warn: (w: ToolWarning) => void): { header: string[]; title: string | null; given: Record<string, string> } {
  const v: Partial<Record<string, string>> = {};
  const unknown: string[] = [];
  for (const [k, raw] of Object.entries(input.meta)) {
    const f = META_RECORD_KEYS[k.trim().toLowerCase()];
    const val = String(raw).replace(/\s+/g, " ").trim();
    if (f === undefined) unknown.push(k);
    else if (val !== "") v[f] = val;
  }
  if (unknown.length > 0) warn({ code: "META_IGNORED", message: `meta tidak dipakai laporan kerja: ${unknown.slice(0, 8).join(", ")} (dikenal: status, owner, verdict, initiator, taskRef, reportedAt, cardIds, title)` });
  const def = getContractKindDef(MD_REPORT_DEFAULT_KIND);
  const statuses = { ...RECORD_STATUS_EXTRA, ...(def?.aliases.statuses ?? {}) } as Record<string, string>;
  let status = v.status !== undefined ? lookupStatus(statuses, v.status) : undefined;
  const given: Record<string, string> = {};
  if (status !== undefined) given.status = status;
  if (status === undefined) {
    warn({ code: "STATUS_DEFAULTED", message: v.status !== undefined ? `meta.status "${v.status}" tidak dikenal; dipakai draft (pilihan: draft, complete, partial, blocked, needs-review)` : "meta.status tidak diisi; dipakai draft (isi meta.status: complete bila pekerjaan selesai)" });
    status = "draft";
  }
  let owner = v.owner?.toLowerCase().replace(/\s+/g, "-") ?? null;
  if (owner !== null && !ACTOR_RE.test(owner)) {
    warn({ code: "OWNER_INVALID", message: `meta.owner "${v.owner}" bukan id agen (huruf kecil, angka, . _ -); diganti agentId` });
    owner = null;
  }
  if (owner !== null) given.owner = owner;
  if (owner === null && input.agentId !== null) {
    const a = input.agentId.trim().toLowerCase();
    if (ACTOR_RE.test(a)) owner = a;
  }
  let reportedAt = v.reportedAt ?? null;
  if (reportedAt !== null && !REPORTED_AT_RE.test(reportedAt)) {
    warn({ code: "REPORTED_AT_DEFAULTED", message: `meta.reportedAt "${reportedAt}" bukan YYYY-MM-DD; dipakai jam server (WIB)` });
    reportedAt = null;
  }
  if (reportedAt !== null) given.reportedAt = reportedAt;
  normalizeOptionalFields(v, warn);
  for (const f of ["verdict", "initiator", "taskRef", "cardIds"] as const) if (v[f] !== undefined) given[f] = v[f] as string;
  const header = [`Status: ${status}`, ...(owner !== null ? [`Owner: ${owner}`] : []), `ReportedAt: ${reportedAt ?? wibStamp(input.now)}`];
  for (const [f, label] of [["verdict", "Verdict"], ["initiator", "Initiator"], ["taskRef", "TaskRef"], ["cardIds", "CardIds"]] as const) if (v[f] !== undefined) header.push(`${label}: ${v[f]}`);
  return { header, title: v.title ?? null, given };
}

/**
 * IMPL-W4 butir 2 (saluran meta `studio_edit`): medan kepala record yang diberi agen dan sah (nama kontrak -> nilai
 * baris MD). Medan yang tidak diberi TIDAK dibangkitkan (tanpa status draft / tanggal / owner bawaan).
 */
export function recordMetaFields(meta: Record<string, string>, agentId: string | null, now: number, warn: (w: ToolWarning) => void): Record<string, string> {
  const ws: ToolWarning[] = [];
  const { given } = recordLines({ mission: "", docKey: "", title: null, meta, sections: [], agentId, now }, (w) => ws.push(w));
  for (const w of ws) {
    if (w.code === "STATUS_DEFAULTED") {
      if (given.status === undefined && Object.keys(meta).some((k) => k.trim().toLowerCase() === "status")) warn({ code: "STATUS_NOT_APPLIED", message: "meta.status tidak dikenal; status tidak diubah (pilihan: draft, complete, partial, blocked, needs-review)" });
    } else if (w.code === "REPORTED_AT_DEFAULTED") warn({ code: "REPORTED_AT_NOT_APPLIED", message: "meta.reportedAt bukan YYYY-MM-DD; tidak diubah" });
    else warn(w);
  }
  return given;
}

/** Paragraf yang dihasilkan satu blok (string dipecah baris kosong; keterangan tabel/grafik = satu paragraf). */
export function expectedParagraphs(b: Block): string[] {
  if (typeof b === "string") return b.trim().split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x !== "");
  if (isRows(b)) return [];
  const o = b as unknown as Record<string, unknown>;
  if (isObj(o) && isRows(o.table)) return typeof o.caption === "string" && o.caption.trim() !== "" ? [o.caption.trim()] : [];
  if (isObj(o) && isObj(o.chart)) {
    const c = o.chart as unknown as ChartInput;
    const cap = [c.caption, c.source !== undefined ? `Sumber: ${c.source}` : undefined].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return cap.length > 0 ? [cap.join(". ")] : [];
  }
  if (isObj(o) && typeof o.subheading === "string") return o.subheading.trim() === "" ? [] : [o.subheading.replace(/\s+/g, " ").trim()];
  return [];
}

/** Satu blok -> baris Markdown laporan kerja (paragraf, tabel, daftar, grafik sebagai tabel). */
export function blockLines(b: Block, warn: (w: ToolWarning) => void, where: string, used: Set<string>, prev?: ReadonlyMap<string, string>): string[] {
  if (typeof b === "string") return b.trim() === "" ? [] : paragraphLines(b.trim(), warn, where);
  if (isRows(b)) return b.length === 0 ? [] : tableLines(repairItemTable(b, warn, where, used, prev), warn, where);
  const o = b as unknown as Record<string, unknown>;
  if (isObj(o) && isRows(o.table)) {
    const rows = o.table as Rows;
    const cap = typeof o.caption === "string" && o.caption.trim() !== "" ? ["", ...paragraphLines(o.caption.trim(), warn, where)] : [];
    return rows.length === 0 ? cap : [...tableLines(repairItemTable(rows, warn, where, used, prev), warn, where), ...cap];
  }
  if (isObj(o) && isObj(o.chart)) {
    const c = o.chart as unknown as ChartInput;
    warn({ code: "CHART_AS_TABLE", message: `${where}: laporan kerja tidak memuat figur; data grafik ditulis sebagai tabel` });
    const cap = [c.caption, c.source !== undefined ? `Sumber: ${c.source}` : undefined].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return [...tableLines(chartRows(c), warn, where), ...(cap.length > 0 ? ["", ...paragraphLines(cap.join(". "), warn, where)] : [])];
  }
  if (isObj(o) && Array.isArray(o.list)) {
    const items = (o.list as unknown[]).map((x) => String(x).replace(/\s+/g, " ").trim()).filter((x) => x !== "");
    const guarded = items.map(guardLine);
    if (guarded.some((g, i) => g !== items[i])) warn({ code: "TEXT_ESCAPED", message: `${where}: butir daftar yang menyerupai struktur di-escape agar tetap teks` });
    return guarded.map((x, i) => (o.ordered === true ? `${i + 1}. ${x}` : `- ${x}`));
  }
  if (isObj(o) && typeof o.subheading === "string") {
    // IMPL-W3: laporan kerja tidak punya sub-bagian (setiap `##` = bab); sub-judul ditulis sebagai paragraf.
    warn({ code: "SUBHEADING_AS_PARAGRAPH", message: `${where}: laporan kerja tanpa sub-bagian; sub-judul ditulis sebagai paragraf` });
    return o.subheading.trim() === "" ? [] : paragraphLines(o.subheading.trim(), warn, where);
  }
  throw new McpToolError("INVALID_ARGUMENT", `${where}: blok tidak dikenal (string = paragraf, larik baris = tabel, {table}, {chart}, {list}, {subheading}, {ref})`);
}

/**
 * Masukan minimal -> laporan kerja MD-native (kepala record + `##` per bagian). Melempar SECTION_MISSING bila bab
 * wajib tidak punya isi (satu-satunya hal yang tidak ditebak).
 */
export function buildWorkReport(input: WorkReportInput): BuiltReport {
  const warnings: ToolWarning[] = [];
  const warn = (w: ToolWarning) => warnings.push(w);
  const m = workReportChapters();
  const { header, title: metaTitle, given } = recordLines(input, warn);
  const used = new Set<string>();
  const filled = new Set<string>();
  const chapters: Array<string | null> = [];
  const body: string[] = [];
  const headings: string[] = [];
  const paragraphs: string[][] = [];
  const mapped: string[] = [];
  const extra: string[] = [];
  arrangeRefs(input.sections, warn).forEach((s, i) => {
    const where = `bagian ${i + 1}`;
    const h = mapHeading(s.heading.replace(/\s+/g, " ").trim(), m);
    if (h.how === "alias" || h.how === "words") mapped.push(`"${s.heading.trim()}" -> ${h.heading}`);
    if (h.how === "none") extra.push(s.heading.trim());
    chapters.push(h.key);
    const lines: string[] = [];
    paragraphs.push(s.blocks.flatMap(expectedParagraphs));
    for (const b of s.blocks) {
      const bl = blockLines(b, warn, where, used, input.prevItemStatus);
      if (bl.length > 0) lines.push(...bl, "");
    }
    if (lines.length > 0 && h.key !== null) filled.add(h.key);
    const shown = h.heading.replace(/^#+\s*/, "") || `Bagian ${i + 1}`;
    headings.push(shown);
    body.push(`## ${shown}`, "", ...lines);
  });
  if (mapped.length > 0) warn({ code: "HEADING_MAPPED", message: `judul bagian dipetakan ke bab laporan: ${mapped.join("; ")}` });
  if (extra.length > 0) warn({ code: "HEADING_EXTRA", message: `judul tanpa padanan bab laporan, disimpan sebagai bab tambahan: ${extra.join("; ")}` });
  // IMPL-W3 butir 6: bab wajib tanpa isi tidak lagi menolak; laporan disimpan INCOMPLETE (tanpa render) dan `missing`
  // menyebut semua bab yang kurang sekaligus. Tidak ada isi yang dikarang.
  const missing = m.required.filter((k) => !filled.has(k)).map((k) => m.titles.get(k) ?? k);
  const title = (input.title ?? metaTitle ?? `Laporan kerja ${input.docKey}`).replace(/\s+/g, " ").trim();
  const markdown = [`# ${title.replace(/^#+\s*/, "")}`, "", `mission: ${input.mission}`, `docKey: ${input.docKey}`, ...header, "", ...body].join("\n").replace(/\n{3,}/g, "\n\n");
  return { markdown: `${markdown.trimEnd()}\n`, warnings, chapters, headings, paragraphs, itemKeys: used, recordFields: fieldsOf(header), givenFields: given, missing };
}

// ── Rujukan (IMPL-W3 butir 7) ───────────────────────────────────────────

const REFS_HEADINGS = new Set(["rujukan", "rujukan dokumen", "refs", "references", "referensi", "daftar rujukan"]);
const REL_ALIASES: Readonly<Record<string, string>> = {
  basis: "basis", dasar: "basis", evidence: "evidence", bukti: "evidence", output: "output", keluaran: "output", hasil: "output",
  supersedes: "supersedes", menggantikan: "supersedes", mengganti: "supersedes", replaces: "supersedes",
};
const REF_DOC_RE = /^[a-z0-9]{20,40}$/;
/**
 * IMPL-W9 butir A: blok `append` ke bagian Rujukan laporan kerja -> tabel rujukan. Tabel (larik baris / `{table}`)
 * diteruskan apa adanya seperti `arrangeRefs` studio_write (keterangan tabel tidak dipakai); `{ref}` -> satu tabel
 * hubungan | dokumen | paragraf | revisi. Validasi hubungan/documentId/pid = konverter laporan (jalur yang sama dengan
 * studio_write). Blok lain ditolak (studio_write memindahnya ke bab "Catatan rujukan"; append tidak membuat bab itu).
 */
export function refsAppendTables(blocks: readonly Block[], where: string): Rows[] {
  const out: Rows[] = [];
  const rows: Rows = [];
  blocks.forEach((b, k) => {
    const o = b as unknown as Record<string, unknown>;
    if (isRows(b)) out.push(b);
    else if (isObj(o) && isRows(o.table)) out.push(o.table as Rows);
    else if (isObj(o) && isObj(o.ref)) {
      const r = o.ref as unknown as RefInput;
      const rel = String(r.rel).trim();
      rows.push([REL_ALIASES[rel.toLowerCase()] ?? rel, String(r.documentId).trim(), r.pid ?? "", r.revision !== undefined ? String(r.revision) : ""]);
    } else {
      throw new McpToolError("EDIT_INVALID", `${where} blok ${k + 1}: bagian Rujukan hanya memuat tabel rujukan ([["hubungan","dokumen","paragraf","revisi"], [...]]) atau {ref}; tambahkan teks ke bab lain. Tidak ada yang ditulis`);
    }
  });
  if (rows.length > 0) out.push([["hubungan", "dokumen", "paragraf", "revisi"], ...rows]);
  return out;
}

export const isRefsHeading = (h: string): boolean => REFS_HEADINGS.has(stripNumber(h).toLowerCase().replace(/\s+/g, " ").trim());

/**
 * Blok `{ref}` di bagian mana pun -> satu tabel Rujukan (hubungan | dokumen | paragraf | revisi) di akhir; teks di
 * bagian Rujukan (selain tabel) dipindah ke bagian "Catatan rujukan" agar konverter tidak menolak "baris di luar tabel
 * rujukan". Rujukan tak sah (hubungan/dokumen) disimpan sebagai teks catatan, bukan dibuang.
 */
function arrangeRefs(sections: readonly SectionInput[], warn: (w: ToolWarning) => void): SectionInput[] {
  const rows: Rows = [];
  const notes: Block[] = [];
  const refTables: Block[] = [];
  const out: SectionInput[] = [];
  for (const s of sections) {
    const keep: Block[] = [];
    const refs = isRefsHeading(s.heading);
    for (const b of s.blocks) {
      const o = b as unknown as Record<string, unknown>;
      if (isObj(o) && isObj(o.ref)) {
        const r = o.ref as unknown as RefInput;
        const rel = REL_ALIASES[String(r.rel).trim().toLowerCase()];
        if (rel !== undefined && REF_DOC_RE.test(String(r.documentId).trim())) rows.push([rel, String(r.documentId).trim(), r.pid ?? "", r.revision !== undefined ? String(r.revision) : ""]);
        else {
          notes.push(`Rujukan: ${String(r.rel)} ${String(r.documentId)}${r.pid ? ` ${r.pid}` : ""}`);
          warn({ code: "REF_KEPT_AS_TEXT", message: "rujukan dengan hubungan/documentId tak sah disimpan sebagai teks di Catatan rujukan (hubungan: basis, evidence, output, supersedes; documentId 20-40 huruf kecil/angka)" });
        }
      } else if (refs && (isRows(b) || (isObj(o) && isRows(o.table)))) refTables.push(isRows(b) ? b : (o.table as Rows));
      else if (refs) notes.push(b);
      else keep.push(b);
    }
    if (!refs) out.push({ heading: s.heading, blocks: keep });
  }
  if (notes.length > 0) {
    if (sections.some((s) => isRefsHeading(s.heading))) warn({ code: "REFS_TEXT_MOVED", message: "teks di bagian Rujukan (selain tabel) dipindah ke bagian Catatan rujukan; tabel rujukan tetap" });
    out.push({ heading: "Catatan rujukan", blocks: notes });
  }
  if (rows.length > 0) refTables.push([["hubungan", "dokumen", "paragraf", "revisi"], ...rows]);
  if (refTables.length > 0) out.push({ heading: "Rujukan", blocks: refTables });
  return out;
}
