/**
 * Cacat pengikatan register (port `BindDefect` datumbind.py).
 * Dipisah dari index.ts agar submodul bind tidak mengimpor index (siklus).
 */

/** Cacat pengikatan register (kunci tidak ada, tanda/satuan kosong, aritmetika tidak cocok). */
export class BindDefect extends Error {
  readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    this.name = "BindDefect";
    this.key = key;
  }
}
