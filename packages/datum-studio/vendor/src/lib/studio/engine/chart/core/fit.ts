/**
 * engine/chart/core — status "fit" tata letak otomatis (FIG-02a, audit research/18 §6).
 *
 * Aturan aktivasi: `renderChart` merender spec apa adanya lebih dulu. Bila lint geometri
 * (`./geometry`) bersih, hasil itu dikembalikan tanpa perubahan (SVG byte-identik dengan
 * perilaku sebelum FIG-02a). Hanya bila lint menemukan cacat, render diulang di dalam
 * `withFit(...)`: selama itu `fitActive()` bernilai benar dan pembantu tata letak yang
 * sadar-fit (bungkus label sumbu, talang terukur, legenda multi-baris, caption berbungkus,
 * penghindar tabrakan label) boleh mengubah keluaran — masing-masing tetap berpagar
 * pengukurannya sendiri (berubah hanya bila unsurnya memang tidak muat).
 *
 * Status disimpan di variabel modul (render chart sinkron dan tidak reentran di antara
 * dua `withFit`); `withFit` selalu memulihkan status sebelumnya (try/finally).
 */

export interface FitState {
  /** Lebar kanvas (mm) yang sedang dirender. */
  widthMm: number;
  /** Laporan yang dikumpulkan pembantu sadar-fit (AUTO_ORIENT, LABEL_DROPPED, ...). */
  notes: FitNote[];
  /**
   * ENG-FIX #4: jumlah label DATA (label nilai, label titik) yang disembunyikan pembantu
   * sadar-fit (LABEL_DROPPED) pada render ini; dipakai skor kandidat `autofit` sebagai penalti.
   * Label skala (lingkar kisi S-08, tick yang dijarangkan) tidak dihitung: skalanya tetap
   * tergambar. Diisi lewat `fitHidden`.
   */
  hidden?: number;
}

export interface FitNote {
  checkId: string;
  detail: string;
}

let current: FitState | null = null;

/** Benar hanya di dalam `withFit` (render ulang setelah cacat terdeteksi). */
export function fitActive(): boolean {
  return current !== null;
}

/** Status fit aktif, atau `null`. */
export function fitState(): FitState | null {
  return current;
}

/** Catat laporan pembantu sadar-fit (diabaikan bila fit tidak aktif). Unik per checkId+detail. */
export function fitNote(checkId: string, detail: string): void {
  if (!current) return;
  if (!current.notes.some((n) => n.checkId === checkId && n.detail === detail)) current.notes.push({ checkId, detail });
}

/**
 * Catat `n` label data yang disembunyikan (ENG-FIX #4; diabaikan bila fit tidak aktif). Tidak
 * diringkas seperti `fitNote`: dua pemanggilan dengan jumlah sama tetap dijumlahkan.
 */
export function fitHidden(n: number): void {
  if (!current || !(n > 0)) return;
  current.hidden = (current.hidden ?? 0) + n;
}

/** Jalankan `fn` dengan fit aktif; status lama selalu dipulihkan. */
export function withFit<T>(state: FitState, fn: () => T): T {
  const prev = current;
  current = state;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
