/**
 * Penyesuai paragraf apparatus (caption, KUNCI, SUMBER) bersama untuk tabel dan figur DOCX (ronde cakupan
 * C19/C20; review C34 #2: dulu disalin di `figures/figure.ts` dan `tables/render.ts`).
 * - C20 (R-75 `render.rail.reserveColumn`): artefak selebar kolom teks atau lebih sempit membawa apparatusnya
 *   selebar badan 128 mm bila kolom rel dicadangkan (`apparatusReserveTw`); artefak bentang penuh tidak diubah.
 * - C19 (R-74 `render.rhythm.snapToBaseline`): jarak apparatus dikunci ke garis dasar dan leading-nya tetap
 *   (GF-21 (a), `snapApparatusPara`).
 * Kedua opt-in mati = undefined (format peran apa adanya, byte sekarang).
 */
import type { NormUnitKind, ParaFormat, ParamValue } from "../../../contract";
import { apparatusReserveTw, reserveRight } from "./rail";
import { baselineSnapTw, snapApparatusPara } from "./rhythm";

/** Penyesuai format paragraf apparatus; absen = format peran apa adanya. */
export type ParaAdjust = (para: ParaFormat) => ParaFormat;

/**
 * Penyesuai apparatus untuk artefak selebar `widthTw` di unit `unitKind`, atau undefined bila R-74 dan R-75
 * keduanya tidak berlaku. Urutan: cadangan rel kanan dulu, lalu irama garis dasar.
 */
export function apparatusParaAdjust(
  param: (key: string) => ParamValue | undefined,
  unitKind: NormUnitKind | undefined,
  widthTw: number,
): ParaAdjust | undefined {
  const reserve = apparatusReserveTw(param, unitKind, widthTw);
  const base = baselineSnapTw(param);
  if (reserve === undefined && base === undefined) return undefined;
  return (para) => {
    const out = reserveRight(para, reserve);
    return base === undefined ? out : snapApparatusPara(out, base);
  };
}
