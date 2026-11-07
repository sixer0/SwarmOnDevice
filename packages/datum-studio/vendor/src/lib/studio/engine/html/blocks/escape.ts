/**
 * Escaping HTML untuk modul engine/html/blocks (S22). Berkas terpisah agar
 * modul lain (mis. S23 html/tables) dapat mengimpor `./escape` tanpa memuat
 * indeks blok (menghindari siklus impor blocks <-> tables).
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape teks untuk isi elemen DAN nilai atribut berkutip. Karakter kendali
 * C0 (kecuali tab, LF, CR) dibuang karena tidak sah di HTML dan dapat
 * mengacaukan parser hilir. Teks sumber selain itu tidak diubah.
 */
export function escapeHtml(s: string): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Atribut `name="value"` dengan nilai ter-escape; nilai kosong/undefined menghasilkan "". */
export function attr(name: string, value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return "";
  return ` ${name}="${escapeHtml(String(value))}"`;
}

/** Nama wajah fon yang aman dipakai di `font-family` (huruf, angka, spasi, `._-`). */
export function safeFaceName(face: string | undefined): string | undefined {
  if (typeof face !== "string") return undefined;
  const f = face.trim();
  return /^[A-Za-z0-9 _.-]{1,64}$/.test(f) ? f : undefined;
}

/** Heks warna kontrak (6 digit) -> `#RRGGBB`; "auto"/tidak sah -> undefined. */
export function safeHex(hex: string | undefined): string | undefined {
  if (typeof hex !== "string") return undefined;
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

/** Angka berhingga dalam rentang, selain itu undefined. */
export function finite(n: unknown, min = -1e6, max = 1e6): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** Angka ke string CSS ringkas (maks 3 desimal, tanpa nol buntut). */
export function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}
