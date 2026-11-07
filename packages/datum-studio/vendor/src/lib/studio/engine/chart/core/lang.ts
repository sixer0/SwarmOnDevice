/**
 * engine/chart/core — bahasa label struktural di dalam gambar chart (legenda EN: "KEY").
 *
 * Satu-satunya teks struktural yang digambar mesin chart sendiri adalah label baris KUNCI
 * (`keyRow`, CH-04); teks lain datang dari spec penulis. Bahasa dokumen diteruskan pemanggil
 * render (`pureChartSvg(spec, tpl, lang)`), bukan lewat spec (U3: tanpa medan payload baru).
 *
 * Pola sama dengan `fit.ts`: status di variabel modul (render chart sinkron), `withChartLang`
 * selalu memulihkan status sebelumnya (try/finally). Tanpa bahasa / ID = "KUNCI", byte-identik
 * dengan perilaku sebelumnya.
 */

export type ChartLang = "ID" | "EN";

const KEY_LABEL_TEXT: Readonly<Record<ChartLang, string>> = { ID: "KUNCI", EN: "KEY" };

let current: ChartLang = "ID";

/** Label baris KUNCI untuk bahasa render yang aktif. */
export function keyLabelText(): string {
  return KEY_LABEL_TEXT[current];
}

/** Jalankan `fn` dengan bahasa label chart `lang` (tanpa nilai / selain EN = ID); status lama selalu dipulihkan. */
export function withChartLang<T>(lang: ChartLang | undefined, fn: () => T): T {
  const prev = current;
  current = lang === "EN" ? "EN" : "ID";
  try {
    return fn();
  } finally {
    current = prev;
  }
}
