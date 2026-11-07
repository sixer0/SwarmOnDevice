/**
 * engine/diagram/fit — status "fit" tata letak otomatis diagram (FIG-02b, audit research/18 §6
 * P1-10, P1-13, P2-16). Padanan `chart/core/fit.ts` (FIG-02a), dengan status sendiri agar
 * pembantu grafik tidak ikut aktif saat diagram dirender ulang.
 *
 * Aturan aktivasi: `buildDiagramSvg` merakit spec apa adanya lebih dulu. Bila lint geometri
 * diagram (`./lint`) bersih, hasil itu dikembalikan tanpa perubahan (SVG byte-identik dengan
 * perilaku sebelum FIG-02b). Hanya bila lint menemukan cacat, rakitan diulang di dalam
 * `withDiagramFit(...)`: selama itu `diagramFitActive()` benar dan pembantu sadar-fit (lebar
 * simpul berbasis label + bungkus `<tspan>`, penempatan label tepi tanpa tabrakan, jepit label
 * zona, label rel bus) boleh mengubah keluaran. Setiap pembantu tetap berpagar pengukurannya
 * sendiri: unsur yang sudah muat tidak disentuh.
 *
 * Status disimpan di variabel modul (rakitan diagram sinkron dan tidak reentran);
 * `withDiagramFit` selalu memulihkan status sebelumnya (try/finally).
 */

export interface DiagramFitNote {
  checkId: string;
  detail: string;
  suggest?: string;
}

export interface DiagramFitState {
  notes: DiagramFitNote[];
  /** Tinggi simpul boleh tumbuh per baris label (bawaan benar). */
  grow?: boolean;
  /** Label tepi boleh diganti nomor + baris catatan (menambah tinggi; bawaan benar). */
  numbered?: boolean;
  /**
   * FIG-02b2: jumlah cacat per jenis pada render pertama (`lint.counts`). Pembantu rute hanya
   * aktif pada jenis cacat yang terukur (mis. pemisahan jalur hanya bila ada segmen berimpit).
   */
  defects?: Readonly<Record<string, number>>;
  /** FIG-02b2 P1-14: render pertama ditolak kapasitas (DATUM-37); tata letak boleh beradaptasi. */
  capacity?: boolean;
  /** FIG-02b2 P1-14: mode adaptasi kapasitas yang dicoba (mis. swimlane "time" lalu "pack"). */
  capMode?: string;
  /** FIG-02b2: pembantu rute/urutan dimatikan (kandidat "tanpa rute ulang"). */
  noRoute?: boolean;
}

let current: DiagramFitState | null = null;

/** Benar hanya di dalam `withDiagramFit` (rakitan ulang setelah cacat terdeteksi). */
export function diagramFitActive(): boolean {
  return current !== null;
}

/** Opsi kandidat fit aktif (`grow`, `numbered`); benar bila fit aktif dan opsi tidak dimatikan. */
export function diagramFitAllows(opt: "grow" | "numbered"): boolean {
  return current !== null && current[opt] !== false;
}

/** Jumlah cacat `kind` pada render pertama (0 di luar fit atau bila tidak diukur). */
export function diagramFitDefects(kind: string): number {
  return current?.defects?.[kind] ?? 0;
}

/**
 * Pembantu rute FIG-02b2 (urutan simpul, pemisahan jalur, rute rak/sld) boleh aktif: fit aktif,
 * kandidat tidak mematikan rute, dan sedikitnya satu jenis cacat `kinds` terukur pada render pertama
 * (atau render pertama ditolak kapasitas).
 */
export function diagramFitRoute(...kinds: string[]): boolean {
  if (!current || current.noRoute) return false;
  if (current.capacity) return true;
  return kinds.some((k) => (current?.defects?.[k] ?? 0) > 0);
}

/** Benar bila render pertama ditolak kapasitas dan tata letak boleh beradaptasi (P1-14). */
export function diagramFitCapacity(): boolean {
  return current !== null && current.capacity === true;
}

/** Catat laporan pembantu (diabaikan bila fit tidak aktif). Unik per checkId+detail. */
export function diagramFitNote(checkId: string, detail: string, suggest?: string): void {
  if (!current) return;
  if (current.notes.some((n) => n.checkId === checkId && n.detail === detail)) return;
  current.notes.push(suggest ? { checkId, detail, suggest } : { checkId, detail });
}

/** Jalankan `fn` dengan fit aktif; status lama selalu dipulihkan. */
export function withDiagramFit<T>(state: DiagramFitState, fn: () => T): T {
  const prev = current;
  current = state;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Jalankan `fn` tanpa menyimpan catatan baru (evaluasi percobaan tata letak, FIG-02b2). */
export function diagramFitQuiet<T>(fn: () => T): T {
  const n = current ? current.notes.length : 0;
  try {
    return fn();
  } finally {
    if (current) current.notes.length = n;
  }
}

/** Mode adaptasi kapasitas aktif (`capMode`), atau `undefined`. */
export function diagramFitCapMode(): string | undefined {
  return current?.capacity ? current.capMode : undefined;
}
