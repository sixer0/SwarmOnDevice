/**
 * engine/chart/family-k1 — geometri busur deterministik untuk pie (K-06) dan donut (K-05).
 *
 * Aturan pembulatan (terdokumentasi, sama di semua mesin JS):
 * 1. Sudut batas iris dihitung dari JUMLAH KUMULATIF, bukan dengan menambah sudut iris
 *    satu per satu: a_k = start + arah x 360 x (v_0 + ... + v_k) / total. Galat float
 *    tidak menumpuk, dan batas terakhir tepat start + arah x 360 (iris menutup lingkaran).
 * 2. Sudut diukur searah jarum jam dari jam 12 (0 deg = atas), sesuai registri K-05
 *    `startAngle` ("0 = jam 12"); arah berlawanan = arah -1.
 * 3. Titik pada lingkaran: x = cx + r sin(a), y = cy - r cos(a). Sudut kelipatan tepat
 *    90 deg memakai sin/cos eksak (0, 1, -1) agar tidak muncul 6e-17.
 * 4. Koordinat ditulis lewat `num()` inti: dibulatkan 4 desimal (0,0001 mm) dengan
 *    `Number.prototype.toFixed` (ditetapkan ECMAScript, deterministik), tanpa "-0".
 * 5. Bendera busur: large-arc = 1 bila sapuan > 180 deg; sweep-flag = 1 searah jarum jam
 *    (sumbu y SVG ke bawah). Iris 360 deg (satu bagian bernilai seluruh total) dipecah
 *    menjadi dua busur 180 deg karena busur SVG dengan titik awal = akhir tidak tergambar.
 * 6. Label persen iris memakai pembulatan sisa terbesar (Hamilton) sehingga jumlah label
 *    tepat 100; seri sisa diputus menurut indeks terkecil (stabil).
 */
import { num } from "../core/svg";

/** sin/cos derajat dengan nilai eksak pada kelipatan 90 deg. */
function sinCosDeg(deg: number): [number, number] {
  const q = deg / 90;
  if (Number.isInteger(q)) {
    const k = ((q % 4) + 4) % 4;
    return [
      [0, 1, 0, -1][k],
      [1, 0, -1, 0][k],
    ];
  }
  const rad = (deg * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

/** Titik pada lingkaran pusat (cx, cy) jari-jari r di sudut `deg` (0 = jam 12, searah jarum jam). */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const [s, c] = sinCosDeg(deg);
  return [cx + r * s, cy - r * c];
}

/** Sudut batas iris (panjang n+1) dari nilai >= 0; total harus > 0. */
export function sliceAngles(values: readonly number[], startDeg: number, clockwise: boolean): number[] {
  const total = values.reduce((a, v) => a + v, 0);
  const dir = clockwise ? 1 : -1;
  const out = [startDeg];
  let cum = 0;
  values.forEach((v, i) => {
    cum += v;
    out.push(i === values.length - 1 ? startDeg + dir * 360 : startDeg + (dir * 360 * cum) / total);
  });
  return out;
}

function p(xy: [number, number]): string {
  return `${num(xy[0])} ${num(xy[1])}`;
}

/** Satu busur dari a0 ke a1 (|a1 - a0| <= 360) sebagai perintah "A" (dengan pemecahan 360 deg). */
function arcCmd(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const sweep = Math.abs(a1 - a0);
  const sf = a1 >= a0 ? 1 : 0;
  const R = num(r);
  if (sweep >= 360 - 1e-9) {
    const am = (a0 + a1) / 2;
    return `A ${R} ${R} 0 0 ${sf} ${p(polar(cx, cy, r, am))} A ${R} ${R} 0 0 ${sf} ${p(polar(cx, cy, r, a1))}`;
  }
  return `A ${R} ${R} 0 ${sweep > 180 ? 1 : 0} ${sf} ${p(polar(cx, cy, r, a1))}`;
}

/**
 * Atribut `d` satu iris. `inner` = 0 -> irisan pie (lewat pusat); `inner` > 0 -> cincin
 * donut (busur luar a0->a1, busur dalam a1->a0).
 */
export function slicePath(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number): string {
  const full = Math.abs(a1 - a0) >= 360 - 1e-9;
  if (inner <= 0) {
    if (full) return `M ${p(polar(cx, cy, outer, a0))} ${arcCmd(cx, cy, outer, a0, a1)} Z`;
    return `M ${num(cx)} ${num(cy)} L ${p(polar(cx, cy, outer, a0))} ${arcCmd(cx, cy, outer, a0, a1)} Z`;
  }
  if (full) {
    // Cincin penuh: dua sub-path (luar dan dalam) dengan fill-rule evenodd di pemanggil.
    return `M ${p(polar(cx, cy, outer, a0))} ${arcCmd(cx, cy, outer, a0, a1)} Z M ${p(polar(cx, cy, inner, a1))} ${arcCmd(cx, cy, inner, a1, a0)} Z`;
  }
  return `M ${p(polar(cx, cy, outer, a0))} ${arcCmd(cx, cy, outer, a0, a1)} L ${p(polar(cx, cy, inner, a1))} ${arcCmd(cx, cy, inner, a1, a0)} Z`;
}

/** Persen per bagian dengan pembulatan sisa terbesar (jumlah tepat 100 pada `dec` desimal). */
export function largestRemainderPercent(values: readonly number[], dec: number): number[] {
  const total = values.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return values.map(() => 0);
  const unit = Math.pow(10, dec);
  const target = 100 * unit;
  const exact = values.map((v) => (v / total) * target);
  const floors = exact.map((e) => Math.floor(e + 1e-9));
  let rest = target - floors.reduce((a, v) => a + v, 0);
  const order = exact.map((e, i) => ({ i, r: e - floors[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    floors[o.i] += 1;
    rest -= 1;
  }
  return floors.map((f) => f / unit);
}
