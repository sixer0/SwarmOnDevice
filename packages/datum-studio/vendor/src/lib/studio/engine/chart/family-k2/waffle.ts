/**
 * K-07 Waffle — kisi R x C, satu kotak = total/(R x C) (Tabel 8.3: "Grid 10 x 10, satu
 * kotak 1 %"). Acuan: pustakachart v24_waffle (PC:483, CB1).
 *
 * Parameter: `chart.kind.K-07.grid` "RxC" (default "10x10"; spec galeri boleh [R, C]).
 * Kotak per bagian = metode sisa terbesar (jumlah tepat R x C); bila suatu bagian tidak
 * jatuh tepat pada kotak bulat -> REPORT `K-07` ("Hindari bila angka tidak bulat").
 * Urutan isi: baris dari atas, kiri ke kanan, bagian sesuai urutan data (PC:487-491).
 *
 * Gaya `gallery` (panel Gambar 8.3): bagian beraksen signal, sisanya ink100/ink200/...;
 * label besar Plex Mono "<nilai> <satuan>" bagian beraksen (atau bagian pertama) di
 * kanan kisi. Gaya `datum`: baris KUNCI "<nama> <nilai>" di atas kisi (pengganti legenda
 * glif PC:494-498), catatan "1 kotak = ..." di bawah; semua teks 6,5 pt (legenda PC:496,
 * S79 E2). Peran warna datum (S79 E3, PC:486 `[VERD, SIGNAL, INK200]`): bagian non-aksen
 * bergiliran improving (verd), signal, ink200, ink400, ink700; bila ada bagian beraksen
 * eksplisit, bagian itu = peran accent dan signal dikeluarkan dari giliran (satu subjek aksen).
 * Petunjuk galeri `valueLabel` (IP-41c): teks label besar di kanan kisi (kedua gaya).
 */
import type { ChartRenderer } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { keyRow, keyRowExtraMm } from "../core/apparatus";
import { defect } from "../core/guards";
import { kindStr } from "../core/read";
import { escAttr, textWidthMm } from "../core/svg";
import {
  KEY_BAND_MM,
  beginChart,
  categoricalPoints,
  contextShades,
  endChart,
  kindGrid,
  largestRemainder,
  mid,
  partColours,
  pt,
  report,
  sum,
} from "./common";

export const renderWaffle: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-07", spec, canvas, tpl);
  const { doc, pal, dec, unit } = ctx;
  const T = { label: pt(ctx, ctx.style === "gallery" ? 6.4 : 6.5), big: pt(ctx, 8.0), tick: pt(ctx, 6.5) };
  const pts = categoricalPoints(ctx);
  const { rows, cols } = kindGrid(ctx, "grid") ?? { rows: 10, cols: 10 };
  const cells = rows * cols;
  const total = sum(pts.map((p) => p.value));
  if (!(total > 0)) throw defect("DC-G1", `${ctx.fid} — waffle tanpa nilai positif`, { code: ctx.code });
  const { counts, inexact } = largestRemainder(
    pts.map((p) => p.value),
    cells,
  );
  if (inexact) {
    report(ctx, "K-07", `nilai tidak jatuh pada kotak bulat (1 kotak = ${fmt(total / cells, 3)}${unit ? ` ${unit}` : ""}); dibulatkan sisa terbesar: ${pts.map((p, i) => `${p.label} ${counts[i]}`).join(", ")}`);
  }
  const accents = pts.map((p) => p.accent);
  const datumShades = accents.some((a) => a)
    ? [pal.role.improving, pal.ink200, pal.ink400, pal.ink700]
    : [pal.role.improving, pal.signal, pal.ink200, pal.ink400, pal.ink700];
  const colours = partColours(ctx, accents, ctx.style === "gallery" ? contextShades(ctx, [pal.ink100, pal.ink200, pal.ink400, pal.ink700]) : datumShades);

  const { x0, x1 } = ctx;
  let { y0, y1 } = ctx;
  let sideLabel = "";
  let sideW = 0;
  const hintLabel = kindStr(ctx, "valueLabel");
  if (hintLabel !== undefined || ctx.style === "gallery") {
    const pick = pts.find((p) => p.accent) ?? pts[0];
    sideLabel = hintLabel ?? withUnit(fmt(pick.value, dec), unit);
    sideW = textWidthMm(sideLabel, T.big, "data") + 3.0;
  }
  if (ctx.style !== "gallery") {
    const keyItems = pts.map((p, i) => ({ label: `${p.label} ${withUnit(fmt(p.value, dec), unit)}`, color: colours[i] }));
    keyRow(doc, x0, y0 + 3.0, keyItems, pal, T.label);
    y0 += KEY_BAND_MM + keyRowExtraMm(x0, keyItems.map((k) => k.label), T.label);
    y1 -= 4.0;
  }

  const pitch = Math.max(0.5, Math.min((y1 - y0) / rows, (x1 - x0 - sideW) / cols));
  const gap = Math.min(0.35, pitch * 0.1);
  const gw = pitch * cols;
  const gh = pitch * rows;
  const gx = x0 + (x1 - x0 - (gw + sideW)) / 2;
  const gy = y0 + (y1 - y0 - gh) / 2;

  let k = 0;
  pts.forEach((p, i) => {
    for (let n = 0; n < counts[i]; n++, k++) {
      const r = Math.floor(k / cols);
      const c = k % cols;
      doc.rect(gx + c * pitch + gap / 2, gy + r * pitch + gap / 2, pitch - gap, pitch - gap, colours[i], {
        mark: { mark: "cell", series: p.label, index: i },
        attrs: ` data-cell="${k}"`,
      });
    }
  });

  if (sideLabel) {
    doc.text(gx + gw + 3.0, mid(gy + gh / 2, T.big), sideLabel, {
      face: "data",
      sizePt: T.big,
      fill: pal.ink900,
      attrs: ` data-label="value" data-for="${escAttr((pts.find((p) => p.accent) ?? pts[0]).label)}"`,
    });
  }
  if (ctx.style !== "gallery") {
    const per = withUnit(fmt(total / cells, inexact ? Math.max(dec, 1) : dec), unit);
    doc.text((x0 + x1) / 2, ctx.y1 - 0.6, `1 kotak = ${per}`, { sizePt: T.tick, fill: pal.ink400, anchor: "middle" });
  }
  return endChart(ctx);
};
