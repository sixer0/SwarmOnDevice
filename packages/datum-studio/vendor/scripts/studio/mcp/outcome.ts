/**
 * IMPL-W3 (D-534 akar 1): klasifikasi hasil galat alat MCP. Klien MCP Hermes menghitung setiap hasil `isError: true`
 * sebagai kegagalan server (pemutus sirkuit 3 berturut-turut -> server "unreachable" 60 s). Penolakan yang DAPAT
 * DIPERBAIKI agen (validasi, tidak ketemu, ganda, konflik, bagian kurang, penolakan pemilik, kapasitas) dikirim sebagai
 * hasil NORMAL (`ok: false` + `code` + `hint` satu baris, pembungkus data tak tepercaya tetap). `isError: true` hanya
 * untuk kegagalan nyata: server tak terjangkau, 5xx, galat internal, rahasia tidak ada. Log server tetap `ok:false` +
 * `code` (penghitung galat uji membaca log).
 */

/** Kode kegagalan nyata (bukan kesalahan isi/argumen agen). */
const GENUINE = new Set([
  "SECRET_MISSING",
  "INTERNAL_ERROR",
  "REMOTE_UNREACHABLE",
  "REMOTE_TIMEOUT",
  "REMOTE_BAD_RESPONSE",
  "REMOTE_REDIRECT",
  "REMOTE_UNAUTHORIZED",
  "REMOTE_ERROR",
  "WRITE_INTERRUPTED",
  "USAGE_ERROR",
]);

/** true = kegagalan nyata (`isError: true`); false = hasil normal yang dapat diperbaiki agen. */
export function isGenuineFailure(code: string, httpStatus?: number): boolean {
  if (GENUINE.has(code)) return true;
  if (typeof httpStatus === "number" && httpStatus >= 500) return true;
  return /^HTTP_5\d\d$/.test(code);
}

/** Petunjuk satu baris per kode (disusun MCP, bukan teks server). */
const HINTS: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: "perbaiki argumen sesuai rincian (pointer + pesan skema) lalu ulangi sekali",
  PAYLOAD_TOO_LARGE: "pecah isi menjadi beberapa panggilan (studio_write lalu studio_edit {after, insert})",
  TEXT_NOT_FOUND: "pilih salah satu kandidat (section/row/column) lalu ulangi dengan section, atau pakai { cell: { section, row, column }, value }",
  TEXT_AMBIGUOUS: "tambahkan section, pakai { cell: { section, row, column }, value }, atau occurrence: \"all\" bila semua kemunculan memang diganti",
  EDIT_INVALID: "ubah suntingan sesuai pesan (mis. replace berisi sisa kalimat) lalu ulangi",
  EDIT_UNSAFE: "tulis ulang bagian itu dengan studio_write",
  CONTENT_INJECTION: "tulis teks biasa di paragraf dan data di blok tabel; jangan menulis sintaks Markdown struktur",
  CONTENT_INVALID: "perbaiki semua isu di rincian sekaligus lalu ulangi studio_write sekali",
  SECTION_MISSING: "tambahkan bagian yang disebut dengan studio_write atau studio_edit",
  META_MISSING: "isi meta yang disebut (mis. title, author) lalu ulangi",
  TABLE_UNIT_MISSING: "tulis satuan di judul kolom angka, mis. \"Daya (MW)\", atau di keterangan \"(MW)\"",
  TABLE_TOO_WIDE: "pecah tabel menjadi beberapa tabel (maks 20 kolom)",
  CHART_DATA_INVALID: "samakan jumlah nilai setiap seri dengan jumlah kategori",
  CHART_TOO_MANY_SERIES: "pecah grafik atau set stacked: true",
  DOCUMENT_NOT_FOUND: "buat dokumen dulu dengan studio_write atau periksa documentId",
  DOCUMENT_OWNED_BY_OTHER: "pakai docKey lain, atau adoptExisting: true bila memang ditugasi",
  DOCUMENT_CHANGED_BY_OTHER: "ubah bagian tertentu dengan studio_edit (membaca revisi terkini)",
  REPORT_CHANGED_BY_OTHER: "ubah bagian tertentu dengan studio_edit (membaca revisi terkini)",
  BASIS_MISSING: "pakai studio_edit (basis dibaca otomatis) atau sertakan baseRevisionNo",
  BASE_CONFLICT: "ulangi studio_edit: alat membaca revisi terkini lebih dulu",
  SCOPE_CONFLICT: "baca isi terbaru lalu ulangi dengan revisi terbaru",
  RATE_LIMITED: "tunggu beberapa detik lalu ulangi sekali (bukan galat server)",
  AGENT_ID_LOCKED: "hapus argumen agentId (server memakai agentId bawaan)",
  TEMPLATE_NOT_FOUND: "sebut slug templat dari studio_templates_list",
  POSITION_MISMATCH: "baca ulang paragraf (studio_document_get view=paragraphs) lalu ulangi dengan at/expect terbaru",
  POSITION_INVALID: "geser at/length ke batas karakter utuh (jangan memotong emoji/pasangan surrogate)",
  PART_CHANGED_BY_OTHER: "bagian yang disebut terakhir ditulis pihak lain; ubah bagian itu dengan studio_edit (membaca revisi terkini), atau kirim tanpa bagian itu",
};

/** W3-I1: petunjuk sesudah penolakan identik berulang di satu sesi. */
export const REPEAT_HINT = "berhenti mengulang; ubah isi atau tanya controller";
/** IMPL-W4 (review 13 Low): galat nyata server berulang -> penyebabnya server, bukan isi agen. */
export const REPEAT_HINT_SERVER = "server bermasalah; tunggu lalu coba lagi (isi Anda bukan penyebabnya); bila tetap gagal, laporkan correlationId ke controller";
/** W3-I1: ambang penolakan identik berturut-turut. */
export const REPEAT_LIMIT = 3;

export function hintFor(code: string): string {
  return HINTS[code] ?? "baca rincian, perbaiki masukan, lalu ulangi sekali";
}
