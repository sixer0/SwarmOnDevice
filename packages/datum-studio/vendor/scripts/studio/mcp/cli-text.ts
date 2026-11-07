/**
 * MCP-06 (D-469): petakan istilah CLI `studio-report` di teks yang berasal dari logika bersama
 * (formatter dan pesan galat studio-report.ts) ke nama alat/parameter MCP. Hanya lapisan MCP yang memetakan;
 * keluaran CLI tidak berubah. Dipakai untuk teks hasil, catatan, dan pesan galat — BUKAN untuk isi dokumen
 * asal server (medan `markdown`, `refresh`, dll.), agar isi tidak diubah.
 */

/** Nama medan yang memuat isi dokumen asal server: tidak dipetakan. */
const CONTENT_KEYS = new Set(["markdown", "refresh", "content", "snippet", "summary", "title"]);

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Perintah lengkap -> alat MCP (lebih dulu dari token opsi)
  [
    /studio-report refresh (\S+) .+? --write\s+\(menimpa .*?lalu update HANYA berkas itu\)/g,
    (_m, id) => `studio_report_refresh (documentId ${id}; hasil di medan markdown, simpan dengan write=true atau outPath bila STUDIO_MCP_FILE_ROOTS diisi, lalu panggil studio_report_update dengan hasil itu)`,
  ],
  [/studio-report refresh (\S+) \S+ --out-md <[^>]*>/g, (_m, id) => `studio_report_refresh (documentId ${id})`],
  [/studio-report (?:refresh|update) (\S+) \S+/g, (m, id) => `${m.startsWith("studio-report refresh") ? "studio_report_refresh" : "studio_report_update"} (documentId ${id})`],
  [/studio-report submit \S+/g, "studio_report_submit"],
  [/studio-report (submit|update|check|refresh|template)\b/g, (_m, c) => `studio_report_${c}`],
  [/\(pakai --json untuk daftar lengkap\)/g, "(daftar lengkap di structuredContent: blocks[].issues)"],
  // Penyimpanan berkas
  [/\(pakai --out <dir> untuk menyimpan\)/g, "(berkas final tidak ditulis oleh alat ini; simpan dengan studio_file_verify { fileId: render.fileId, downloadDir })"],
  [/\(laporan gabungan di stdout; --out-md <berkas> atau --write untuk menyimpan\)/g, "(laporan gabungan ada di medan markdown; simpan dengan outPath atau write=true)"],
  [/--out-md <[^>]*>/g, "outPath"],
  [/--out-md\b/g, "outPath"],
  [/--write\b/g, "write=true"],
  // Basis
  [/; --force-latest hanya bila Anda yakin tidak ada penulis lain/g, "; lewat MCP revisi terkini server tidak dipakai sebagai basis"],
  [/--base-rev <n>/g, "baseRev"],
  [/--base-rev\b/g, "baseRev"],
  [/--force-latest\b/g, "force-latest"],
  // Bagian
  [/dengan --section ([\w,-]+)/g, (_m, list) => `dengan sections: ${JSON.stringify(String(list).split(",").filter((s) => s !== ""))}`],
  [/--section\b/g, "sections"],
  // Opsi lain
  [/--allow-remove\b/g, "allowRemove=true"],
  [/--allow-example\b/g, "allowExample=true"],
  [/--require-complete\b/g, "requireComplete=true"],
  [/--mission <folder>/g, "parameter mission"],
  [/--doc-key\b/g, "docKey"],
  [/\(tambahkan --remote <url>\)/g, "(remote=true menjalankannya)"],
  [/--remote <url>/g, "remote=true"],
  [/jalankan update lagi dengan berkas hasil refresh/g, "panggil studio_report_update lagi dengan hasil refresh"],
  [/jalankan update dengan berkas itu/g, "panggil studio_report_update dengan laporan itu"],
  [/<laporan\.md>/g, "laporan Anda"],
];

/** Petakan istilah CLI di satu teks ke istilah MCP. */
export function mcpText(s: string): string {
  let out = s;
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  return out;
}

/** Pemetaan mendalam untuk catatan/galat terstruktur; medan isi dokumen asal server dilewati. */
export function mcpTextDeep(v: unknown): unknown {
  if (typeof v === "string") return mcpText(v);
  if (Array.isArray(v)) return v.map(mcpTextDeep);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, CONTENT_KEYS.has(k) ? x : mcpTextDeep(x)]));
  }
  return v;
}
