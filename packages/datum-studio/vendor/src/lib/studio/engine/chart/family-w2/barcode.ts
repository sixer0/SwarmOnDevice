/**
 * W-08 Barcode: garis tegak di setiap kejadian (S40). Acuan pustakachart `v60_barcode`
 * (PC:938-950, kelas CB2): satu baris garis tipis ink900 (opasitas 0,6) dan garis
 * median signal berlabel "median <nilai>". Cek CB2: jumlah garis = jumlah kejadian.
 *
 * Data `distribution`: tiap grup = satu jenis kejadian, `values` = waktu kejadian
 * (angka pada sumbu). Parameter registri: `rowPerEventType` (false = semua jenis dalam
 * satu baris), `riskyTypeColour` (tokenRef, bawaan alert) untuk jenis berisiko yang
 * didaftar `chart.kind.W-08.riskyTypes` (ParamDef mesin IP-25); jendela sorot opsional
 * `chart.kind.W-08.highlightWindow` [awal, akhir] (rona aksen 22 %, dekorasi).
 * Aksen: `accent.group` = satu jenis kejadian. Median hanya digambar pada gaya datum
 * dengan satu baris. Petunjuk galeri `axis` (IP-41c): domain waktu tercetak [min, maks].
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { tintHex } from "../../tokens/color";
import { defect, figureLabel } from "../core/guards";
import { chartParam, kindKey, paramBool, resolveChartColor } from "../core/palette";
import { kindAxis } from "../core/read";
import { axisDomain, decimalsFor, linearScale } from "../core/scale";
import { textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, mid, openFrame, requireShape } from "./common";

const CODE = "W-08";

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function renderBarcode(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "distribution");
  if (!Array.isArray(data.groups) || data.groups.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code: CODE });
  data.groups.forEach((g, i) => {
    if (typeof g?.name !== "string" || !Array.isArray(g.values) || g.values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      throw defect("DC-G1", `${fid} — jenis kejadian ${i} tanpa nama atau nilai hingga`, { code: CODE, index: i });
    }
  });
  const all = data.groups.flatMap((g) => g.values);
  if (all.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa kejadian`, { code: CODE });

  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;
  const dec = spec.dec ?? 0;

  const perType = paramBool(spec, tpl, kindKey(CODE, "rowPerEventType"), true);
  const rows = perType ? data.groups.map((g) => g.name) : [""];
  const showLabels = rows.length > 1 || (gallery && rows[0] !== "");
  const riskyColour = resolveChartColor(spec, tpl, kindKey(CODE, "riskyTypeColour"), pal.role.limitExceeded);
  const riskyRaw = chartParam(spec, tpl, kindKey(CODE, "riskyTypes"));
  const risky = new Set(Array.isArray(riskyRaw) ? riskyRaw.filter((v): v is string => typeof v === "string") : []);

  const hint = accentHint(spec);
  const accentGroup = hint.group !== undefined && data.groups.some((g) => g.name === hint.group) ? hint.group : undefined;
  assertAccentCount(spec, CODE, accentGroup ? 1 : 0, f.maxAccent, "jenis kejadian");

  const LBL = gallery ? 6.4 : 6.5;
  const TICK = gallery ? 6.0 : 6.5;
  const lo = Math.min(...all);
  // Petunjuk `axis` = sumbu waktu tercetak (tanpa paksaan nol); tanpa petunjuk = domain rapi lama.
  const axis = kindAxis({ spec, tpl, code: CODE });
  const ad = axisDomain(all, { zero: !axis && lo >= 0 && lo <= (Math.max(...all) - lo) / 2, target: gallery ? 5 : 6 }, axis);
  const dom = ad.dom;
  if (ad.widened) f.issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: ad.widened });
  const labelW = showLabels ? Math.max(...rows.map((s) => textWidthMm(s, LBL))) : 0;
  const tickFace = gallery ? "struct" : "data";
  const halfTick = (v: number): number => textWidthMm(fmt(v, decimalsFor(dom.step)), TICK, tickFace) / 2 + 0.3;
  const x0 = showLabels ? Math.min(Math.max(labelW + 2.4, 6), W * 0.35) : Math.max(0.8, halfTick(dom.min));
  const x1 = W - Math.max(1.0, halfTick(dom.max));
  const sx = linearScale(dom.min, dom.max, x0, x1);

  const single = rows.length === 1;
  const medianOn = !gallery && single;
  const top = medianOn ? 4.2 : 1.6;
  const base = f.bottom - 5.0;
  const step = (base - top) / rows.length;
  const h = Math.min(step * (single ? 0.92 : 0.7), 14);

  // Jendela sorot (dekorasi, di bawah garis).
  const win = chartParam(spec, tpl, kindKey(CODE, "highlightWindow"));
  if (Array.isArray(win) && win.length === 2 && win.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const [a, b] = (win as number[]).map((v) => Math.min(dom.max, Math.max(dom.min, v)));
    doc.rect(sx(Math.min(a, b)), top, Math.abs(sx(b) - sx(a)), base - top, tintHex(pal.paper, pal.role.accent, 22), { attrs: ' data-highlight="window"' });
  }

  if (showLabels) rows.forEach((s, r) => doc.text(x0 - 1.6, mid(top + step * (r + 0.5), LBL), s, { sizePt: LBL, fill: gallery ? pal.ink400 : pal.ink700, anchor: "end" }));

  data.groups.forEach((g, gi) => {
    const r = perType ? gi : 0;
    const yc = top + step * (r + 0.5);
    const c = g.name === accentGroup ? pal.role.accent : risky.has(g.name) ? riskyColour : gallery ? pal.ink400 : pal.ink900;
    const opacity = gallery || g.name === accentGroup || risky.has(g.name) ? "" : ' stroke-opacity="0.6"';
    g.values.forEach((v, j) => {
      doc.line(sx(v), yc - h / 2, sx(v), yc + h / 2, c, gallery ? 0.2 : 0.18, {
        mark: { mark: "line", series: g.name, index: gi },
        attrs: ` data-event="${j}"${opacity}`,
      });
    });
  });

  if (medianOn) {
    const m = median(all);
    const c = accentGroup ? pal.ink900 : pal.role.accent;
    doc.line(sx(m), top - 0.4, sx(m), base, c, 0.42, { attrs: ' data-stat="median"' });
    const s = `median ${withUnit(fmt(m, dec), spec.unit)}`;
    const right = sx(m) + 0.6 + textWidthMm(s, 6.4, "data") <= W;
    doc.text(right ? sx(m) + 0.6 : sx(m) - 0.6, top - 1.2, s, { sizePt: 6.4, fill: c, face: "data", anchor: right ? "start" : "end" });
  }

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, 0.25);
  const tdec = decimalsFor(dom.step);
  for (const t of dom.ticks) doc.text(sx(t), base + 3.4, fmt(t, tdec), { sizePt: TICK, fill: pal.ink400, anchor: "middle", face: tickFace });
  doc.close();
  if (!gallery && spec.unit && !medianOn) doc.text(W - 0.5, 2.4, spec.unit, { sizePt: 6.0, fill: pal.ink400, anchor: "end" });

  return closeFrame(f, spec);
}
