/**
 * K-08 Icon array — satu ikon = satu unit (Tabel 8.3). Acuan pustakachart v26_icon_circles
 * (PC:524) PARSIAL: acuan menggambar lingkaran berluas proporsional, katalog meminta satu
 * ikon per unit; Studio mengikuti katalog (cek CB2: jumlah unit = jumlah ikon).
 *
 * Ikon = primitif geometris SVG (tanpa aset eksternal, D-38): `person` (kepala lingkaran +
 * badan persegi, panel Gambar 8.3), `circle`, `square`. Setiap ikon dibungkus
 * `<g data-mark="point" data-series="<bagian>" data-index="<i bagian>" data-unit="<k>">`.
 *
 * Kunci lokal (tanpa ParamDef): `grid` [baris, kolom] atau "RxC" (default: <= 10 per
 * baris), `icon` person | circle | square (alias orang | lingkaran | kotak), `caption`
 * (teks di bawah kisi; default "<aksen> dari <total> [satuan]" bila ada bagian beraksen).
 * Nilai wajib bilangan bulat >= 0 (satu ikon satu unit); total > 100 -> defect (Hindari:
 * jumlah besar; pakai waffle K-07).
 */
import type { ChartRenderer } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { keyRow, keyRowExtraMm } from "../core/apparatus";
import { defect } from "../core/guards";
import { escAttr, hexColor } from "../core/svg";
import {
  KEY_BAND_MM,
  beginChart,
  categoricalPoints,
  contextShades,
  endChart,
  invalidParam,
  kindGrid,
  kindParam,
  kindStr,
  partColours,
  pt,
  sum,
} from "./common";

export const MAX_ICON_UNITS = 100;

const ICON_ALIASES: Readonly<Record<string, "person" | "circle" | "square">> = {
  person: "person",
  orang: "person",
  circle: "circle",
  lingkaran: "circle",
  square: "square",
  kotak: "square",
};

export const renderIconArray: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-08", spec, canvas, tpl);
  const { doc, pal, unit } = ctx;
  const T = { label: pt(ctx, ctx.style === "gallery" ? 6.4 : 6.2) };
  const pts = categoricalPoints(ctx);
  const bad = pts.findIndex((p) => !Number.isInteger(p.value));
  if (bad >= 0) {
    throw defect("K-08", `${ctx.fid} — icon array: nilai titik ${bad} (${pts[bad].value}) bukan bilangan bulat; satu ikon = satu unit`, {
      code: ctx.code,
      index: bad,
    });
  }
  const total = sum(pts.map((p) => p.value));
  if (total < 1) throw defect("DC-G1", `${ctx.fid} — icon array tanpa unit`, { code: ctx.code });
  if (total > MAX_ICON_UNITS) {
    throw defect("K-08", `${ctx.fid} — ${total} ikon > ${MAX_ICON_UNITS}; jumlah besar, pakai waffle (K-07)`, { code: ctx.code, units: total });
  }

  const iconRaw = kindParam(ctx, "icon");
  const icon = iconRaw === undefined ? "person" : typeof iconRaw === "string" ? ICON_ALIASES[iconRaw] : undefined;
  if (!icon) throw invalidParam(ctx, "icon", iconRaw, Object.keys(ICON_ALIASES).join(" | "));

  const autoRows = Math.ceil(total / 10);
  const grid = kindGrid(ctx, "grid") ?? { rows: autoRows, cols: Math.ceil(total / autoRows) };
  if (grid.rows * grid.cols < total) {
    throw invalidParam(ctx, "grid", [grid.rows, grid.cols], `kisi yang memuat ${total} ikon`);
  }

  const colours = partColours(
    ctx,
    pts.map((p) => p.accent),
    contextShades(ctx, [pal.ink200, pal.ink400, pal.ink100, pal.ink700]),
  );
  const acc = pts.find((p) => p.accent);
  const caption =
    kindStr(ctx, "caption") ?? (acc ? `${fmt(acc.value, 0)} dari ${withUnit(fmt(total, 0), unit)}` : undefined);

  const { x0, x1 } = ctx;
  let { y0, y1 } = ctx;
  if (ctx.style === "datum") {
    const keyItems = pts.map((p, i) => ({ label: `${p.label} ${fmt(p.value, 0)}`, color: colours[i] }));
    keyRow(doc, x0, y0 + 3.0, keyItems, pal, T.label);
    y0 += KEY_BAND_MM + keyRowExtraMm(x0, keyItems.map((k) => k.label), T.label);
  }
  const capBand = caption ? 4.6 : 0;
  y1 -= capBand;

  // Sisi ikon s; jarak pusat 0,95 s mendatar dan 1,4 s tegak (panel Gambar 8.3), maks 9 mm.
  const s = Math.max(
    0.6,
    Math.min((x1 - x0) / (grid.cols * 0.95 + 0.05), (y1 - y0) / (grid.rows * 1.4 - 0.4), 9),
  );
  const pitch = s * 0.95;
  const pitchY = s * 1.4;
  const blockW = pitch * (grid.cols - 1) + s;
  const blockH = pitchY * (grid.rows - 1) + s;
  const bx = x0 + (x1 - x0 - blockW) / 2;
  const by = y0 + (y1 - y0 - blockH) / 2;

  let k = 0;
  pts.forEach((p, i) => {
    const fill = colours[i];
    for (let n = 0; n < p.value; n++, k++) {
      const r = Math.floor(k / grid.cols);
      const c = k % grid.cols;
      const left = bx + c * pitch;
      const top = by + r * pitchY;
      doc.open(`data-mark="point" data-series="${escAttr(p.label)}" data-index="${i}" data-unit="${k}" fill="${hexColor(fill)}"`);
      if (icon === "person") {
        doc.circle(left + s / 2, top + s * 0.2, s * 0.2, fill);
        doc.rect(left + s * 0.24, top + s * 0.45, s * 0.52, s * 0.55, fill);
      } else if (icon === "circle") {
        doc.circle(left + s / 2, top + s / 2, s * 0.42, fill);
      } else {
        doc.rect(left + s * 0.1, top + s * 0.1, s * 0.8, s * 0.8, fill);
      }
      doc.close();
    }
  });

  if (caption) {
    doc.text((x0 + x1) / 2, Math.min(by + blockH + 4.0, ctx.y1 - 0.4), caption, { sizePt: T.label, fill: pal.ink700, anchor: "middle" });
  }
  return endChart(ctx);
};
