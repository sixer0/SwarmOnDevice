/**
 * engine/chart/family-k1 — K-05 donut dan K-06 pie (S37). Tanpa acuan Python (kelas CC:
 * lint + snapshot, research/06 §6.2); cek khusus research/06:343-344.
 *
 * Parameter registri:
 * - K-05 `maxSlices` (2..5, default 5), `startAngle` (0..359 deg, 0 = jam 12),
 *   `clockwise` (default true);
 * - K-06 `maxSlices` (2..5, default 5), `oneDominant` (default true). K-06 selalu mulai
 *   jam 12 searah jarum jam.
 * Iris > maxSlices -> BY_CONSTRUCTION `chart.kind.<KODE>.maxSlices`. `oneDominant`:
 * iris terbesar harus >= 1,5 x iris terbesar kedua (definisi kerja "satu dominan, hindari
 * selisih kecil", Tabel 8.3); bila tidak -> temuan FAIL `chart.kind.K-06.oneDominant`
 * (lint gerbang rilis, berkas tetap dibuat).
 *
 * Urutan iris = urutan data. Warna: iris beraksen = peran aksen, lainnya ramp tinta
 * (Gambar 8.3: signal, ink400, ink200, ink100), pemisah iris garis kertas 0,35 mm.
 * Iris kunci = iris beraksen, atau iris terbesar (indeks terkecil bila seri).
 * - donut: angka kunci + label iris kunci di tengah lubang (jari-jari dalam 0,68 R);
 * - pie gallery: persen iris kunci di dalam irisnya (Gambar 8.3 "58 %");
 * - gaya datum: lingkaran di kiri + kolom label langsung (nama, nilai/persen) di kanan;
 *   gaya gallery: lingkaran di tengah panel tanpa kolom label.
 * Persen label memakai pembulatan sisa terbesar (arc.ts) sehingga berjumlah 100.
 * Petunjuk galeri (IP-41c): K-05 `centerLabel` ("<angka> <label>": angka besar, label
 * kecil di bawahnya) dan K-06 `sliceLabel` (teks di dalam iris kunci, kedua gaya).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { capacityAdvice } from "../core/intent";
import { chartPalette, paramBool } from "../core/palette";
import { kindStr } from "../core/read";
import { chartFloors } from "../core/prepare";
import { MM_PER_PT, SvgDoc, textWidthMm } from "../core/svg";
import { largestRemainderPercent, polar, sliceAngles, slicePath } from "./arc";
import { K1Report, footBandMm, galleryColors, inkOn, k1Key, paramDeg, paramInt, requireSlices, rootAttrs, styleOf } from "./common";

type PieCode = "K-05" | "K-06";

/** Rasio jari-jari dalam donut terhadap luar (Gambar 8.3 ~0,69). */
export const DONUT_INNER_RATIO = 0.68;
/** Ambang dominan K-06: terbesar >= 1,5 x kedua. */
export const DOMINANCE_RATIO = 1.5;

export function renderPie(code: PieCode, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const rep = new K1Report();
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const fid = figureLabel(spec);
  const pts = requireSlices(spec, code, floors.maxAccent, rep);
  const dec = spec.dec ?? 0;
  const unit = spec.unit ?? "";

  const maxKey = k1Key(code, "maxSlices");
  const maxSlices = paramInt(spec, tpl, maxKey, 5);
  if (pts.length > maxSlices) {
    // FIG-03a: penolakan tetap (tanpa agregasi diam-diam, D-482 butir 1); saran menyebut `topN`.
    throw defect(maxKey, `${fid} — ${pts.length} bagian > ${maxSlices}; ${capacityAdvice(code, maxSlices - 1, "")}, atau pakai stacked bar (K-01) / bar (P-01)`, {
      code,
      slices: pts.length,
    });
  }
  rep.pass(maxKey);
  const values = pts.map((p) => p.value);
  const total = values.reduce((a, v) => a + v, 0);
  if (!(total > 0)) throw defect("DC-G1", `${fid} — ${code}: jumlah bagian 0; lingkaran tidak terdefinisi`, { code });
  if (pts.length < 2) rep.add("K1-SLICES", "REPORT", "satu bagian saja; lingkaran penuh tidak membandingkan apa pun");
  const zero = pts.filter((p) => p.value === 0).map((p) => p.label);
  if (zero.length) rep.add("K1-SLICES", "REPORT", `bagian bernilai 0 tidak digambar: ${zero.join(", ")}`);
  if (unit === "%" && Math.abs(total - 100) > 0.5) {
    rep.add("K1-SUM", "REPORT", `satuan "%" tetapi jumlah bagian ${fmt(total, dec)}; iris dihitung dari porsi jumlah`);
  }

  if (code === "K-06") {
    const key = k1Key("K-06", "oneDominant");
    if (paramBool(spec, tpl, key, true) && pts.length >= 2) {
      const sorted = [...values].sort((a, b) => b - a);
      const ok = sorted[0] >= DOMINANCE_RATIO * sorted[1];
      rep.add(key, ok ? "PASS" : "FAIL", `tidak ada satu bagian dominan (terbesar ${fmt(sorted[0], dec)} < ${DOMINANCE_RATIO} x kedua ${fmt(sorted[1], dec)}); pakai bar (P-01)`);
    }
  }

  const startAngle = code === "K-05" ? paramDeg(spec, tpl, k1Key("K-05", "startAngle"), 0) : 0;
  const clockwise = code === "K-05" ? paramBool(spec, tpl, k1Key("K-05", "clockwise"), true) : true;
  const angles = sliceAngles(values, startAngle, clockwise);
  const pct = largestRemainderPercent(values, dec);
  const colors = galleryColors(
    pts.map((p) => p.accent),
    pal,
    spec,
    code,
  );
  let keyIdx = pts.findIndex((p) => p.accent);
  if (keyIdx < 0) keyIdx = values.indexOf(Math.max(...values));

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, rootAttrs(code, style), chartFloors(spec, tpl).minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const plotH = H - footBandMm(spec);

  let R: number;
  let cx: number;
  const cy = plotH / 2;
  if (style === "gallery") {
    R = Math.max(2, Math.min(W, plotH) / 2 - 1.0);
    cx = W / 2;
  } else {
    R = Math.max(2, Math.min(plotH - 2, W * 0.45) / 2);
    cx = 1 + R;
  }
  const inner = code === "K-05" ? R * DONUT_INNER_RATIO : 0;
  const series = unit || "nilai";

  pts.forEach((pt, i) => {
    if (pt.value === 0) return;
    const full = Math.abs(angles[i + 1] - angles[i]) >= 360 - 1e-9;
    const rule = full && inner > 0 ? ' fill-rule="evenodd"' : "";
    doc.path(slicePath(cx, cy, R, inner, angles[i], angles[i + 1]), colors[i], {
      mark: { mark: "slice", series, index: i },
      stroke: pal.paper,
      strokeWidthMm: 0.35,
      attrs: `${rule} stroke-linejoin="round"`,
    });
  });

  const keyText = (i: number): string => (unit && unit !== "%" ? withUnit(fmt(values[i], dec), unit) : withUnit(fmt(pct[i], dec), "%"));

  const own = { spec, tpl, code };
  if (code === "K-05") {
    // `centerLabel` "68 % pemerintah" -> angka "68 %" + label "pemerintah".
    const hint = kindStr(own, "centerLabel");
    const m = hint !== undefined ? /^([-+]?\d[\d.,]*(?:\s*%)?)\s+(.+)$/.exec(hint) : null;
    const s = hint === undefined ? keyText(keyIdx) : m ? m[1] : hint;
    const sub = hint === undefined ? pts[keyIdx].label : m ? m[2] : undefined;
    const room = 2 * inner * 0.85;
    const size = Math.max(6.4, Math.min(9, room / Math.max(1, s.length * 0.6 * MM_PER_PT)));
    doc.text(cx, cy - 0.4, s, { face: "data", sizePt: size, fill: pal.ink900, anchor: "middle", attrs: ' data-label="key"' });
    if (sub !== undefined) doc.text(cx, cy + 2.8, sub, { sizePt: 6.4, fill: pal.ink700, anchor: "middle" });
  } else if (style === "gallery" || kindStr(own, "sliceLabel") !== undefined) {
    const sweep = Math.abs(angles[keyIdx + 1] - angles[keyIdx]);
    const s = kindStr(own, "sliceLabel") ?? withUnit(fmt(pct[keyIdx], dec), "%");
    if (sweep >= 25 && textWidthMm(s, 6.4, "data") <= R * 0.9) {
      const [lx, ly] = polar(cx, cy, R * 0.62, (angles[keyIdx] + angles[keyIdx + 1]) / 2);
      doc.text(lx, ly + 0.8, s, { face: "data", sizePt: 6.4, fill: inkOn(colors[keyIdx], pal), anchor: "middle", attrs: ' data-label="value"' });
    }
  }

  if (style === "datum") {
    // Kolom label langsung (P7-13 direct): petak warna, nama, nilai/persen.
    const x = cx + R + 6;
    const rowStep = 5.0;
    const y0 = cy - ((pts.length - 1) * rowStep) / 2;
    const texts = pts.map((pt, i) => {
      const pc = withUnit(fmt(pct[i], dec), "%");
      return unit && unit !== "%" ? `${withUnit(fmt(pt.value, dec), unit)}  (${pc})` : pc;
    });
    // Kolom nilai rata kanan tepat setelah nama terlebar (bukan di tepi kanvas).
    const nameW = Math.max(...pts.map((pt) => textWidthMm(pt.label, 6.6)));
    const valW = Math.max(...texts.map((t) => textWidthMm(t, 6.6, "data")));
    const xv = Math.min(W - 1.5, x + 4.0 + nameW + 4.0 + valW);
    doc.open('data-key="direct"');
    pts.forEach((pt, i) => {
      const y = y0 + i * rowStep;
      doc.rect(x, y - 2.2, 2.6, 2.6, colors[i]);
      doc.text(x + 4.0, y, pt.label, { sizePt: 6.6, fill: pal.ink700 });
      doc.text(xv, y, texts[i], { face: "data", sizePt: 6.6, fill: i === keyIdx ? pal.ink900 : pal.ink700, anchor: "end", attrs: ' data-label="value"' });
    });
    doc.close();
  }

  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: rep.toJSON() };
}
