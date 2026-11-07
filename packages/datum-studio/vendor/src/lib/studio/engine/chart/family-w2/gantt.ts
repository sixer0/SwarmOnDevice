/**
 * W-07 Gantt: batang durasi pada garis waktu dengan milestone (S40). Acuan pustakachart
 * `v94_gantt` (PC:1196-1212, kelas CB1): batang ink900 per tugas, label rentang mono
 * "M<mulai>-<selesai>" di kanan batang, milestone belah ketupat signal + nama, grid x.
 *
 * Data `intervals`: `start`/`end` angka (minggu/hari proyek) atau ISO tanggal (sumbu
 * waktu Indonesia, time.ts); campuran ditolak. Milestone = `milestone: true`, atau item
 * bertitik (start = end) yang labelnya ada di daftar registri `milestones`. Milestone
 * duduk di baris tugas sebelumnya (Gambar 8.4: BAST di baris "Uji terima").
 *
 * Parameter registri: `rowPerTask` (false = satu baris per `group`), `milestones`,
 * `todayLine` (garis hari ini; posisinya dari `chart.kind.W-07.todayAt` (ParamDef mesin IP-25),
 * label `chart.kind.W-07.todayLabel` bawaan "hari ini"), `rowsInProposal` (baris >
 * batas atas -> REPORT; pecah per fase). Warna per `group` (urutan kemunculan): ink400,
 * ink700, ink900, ink200; tanpa grup: ink900 (datum) / ink700 (gallery). Aksen:
 * `accent.point` (label atau indeks item) atau `accent.group`.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { keyRow } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { chartParam, kindKey, paramBool } from "../core/palette";
import { linearScale } from "../core/scale";
import { num, textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, mid, openFrame, requireShape, str } from "./common";
import { type TimeKind, parseTimeValue, timeAxis, timeValueLabel } from "./time";

const CODE = "W-07";

interface Item {
  index: number;
  label: string;
  start: number;
  end: number;
  group?: string;
  milestone: boolean;
  row: number;
}

export function renderGantt(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "intervals");
  if (!Array.isArray(data.items) || data.items.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code: CODE });

  const msList = chartParam(spec, tpl, kindKey(CODE, "milestones"));
  const msNames = new Set(Array.isArray(msList) ? msList.filter((v): v is string => typeof v === "string") : []);
  let kind: TimeKind | undefined;
  const items: Item[] = data.items.map((it, i) => {
    if (typeof it?.label !== "string") throw defect("DC-G1", `${fid} — item ${i} tanpa label`, { code: CODE, index: i });
    const s = parseTimeValue(it.start, `${fid} — W-07 item ${i} start`);
    const e = parseTimeValue(it.end, `${fid} — W-07 item ${i} end`);
    if (s.kind !== e.kind || (kind && kind !== s.kind)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07: angka dan tanggal ISO tidak boleh dicampur`, { code: CODE, index: i });
    }
    kind = s.kind;
    if (e.value < s.value) throw defect("W-07.interval", `${fid} — item ${i} "${it.label}" berakhir sebelum mulai`, { code: CODE, index: i });
    const milestone = it.milestone === true || (s.value === e.value && msNames.has(it.label));
    return { index: i, label: it.label, start: s.value, end: e.value, group: str(it.group), milestone, row: -1 };
  });
  const tkind = kind as TimeKind;

  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;

  // Baris: satu per tugas (rowPerTask) atau satu per grup; milestone ikut baris tugas sebelumnya.
  const rowPerTask = paramBool(spec, tpl, kindKey(CODE, "rowPerTask"), true);
  const rowLabels: string[] = [];
  const rowOfGroup = new Map<string, number>();
  let lastTaskRow = -1;
  for (const it of items) {
    if (it.milestone) continue;
    const key = rowPerTask ? undefined : (it.group ?? it.label);
    if (key !== undefined && rowOfGroup.has(key)) it.row = rowOfGroup.get(key) as number;
    else {
      it.row = rowLabels.length;
      rowLabels.push(key ?? it.label);
      if (key !== undefined) rowOfGroup.set(key, it.row);
    }
  }
  // Galeri: milestone di baris tugas sebelumnya. Datum: baris sendiri di bawah (label rentang
  // mono di ujung batang tidak tertimpa), tanpa label baris; nama di samping belah ketupat.
  for (const it of items) {
    if (!it.milestone) lastTaskRow = it.row;
    else if (gallery && lastTaskRow >= 0) it.row = lastTaskRow;
    else {
      it.row = rowLabels.length;
      rowLabels.push("");
    }
  }
  const proposal = chartParam(spec, tpl, kindKey(CODE, "rowsInProposal"));
  const maxRows = Array.isArray(proposal) && typeof proposal[1] === "number" ? proposal[1] : typeof proposal === "number" ? proposal : undefined;
  if (maxRows !== undefined && rowLabels.length > maxRows) {
    f.issues.push({ checkId: kindKey(CODE, "rowsInProposal"), status: "REPORT", detail: `${rowLabels.length} baris > ${maxRows}; pecah per fase` });
  }

  // Aksen.
  const hint = accentHint(spec);
  const accented = new Set<number>();
  for (const it of items) {
    if (hint.point !== undefined && (hint.point === it.label || hint.point === it.index)) accented.add(it.index);
    if (hint.group !== undefined && it.group === hint.group) accented.add(it.index);
  }
  assertAccentCount(spec, CODE, accented.size, f.maxAccent, "item");

  const groups = [...new Set(items.filter((it) => !it.milestone && it.group !== undefined).map((it) => it.group as string))];
  const ramp = [pal.ink400, pal.ink700, pal.ink900, pal.ink200];
  const groupColour = (g: string | undefined): string => {
    if (g === undefined || groups.length === 0) return gallery ? pal.ink700 : pal.ink900;
    return ramp[groups.indexOf(g) % ramp.length];
  };

  // Garis hari ini.
  const todayOn = paramBool(spec, tpl, kindKey(CODE, "todayLine"), true);
  const todayRaw = chartParam(spec, tpl, kindKey(CODE, "todayAt"));
  let today: number | undefined;
  if (todayOn && (typeof todayRaw === "number" || typeof todayRaw === "string")) {
    const t = parseTimeValue(todayRaw, `${fid} — chart.kind.W-07.todayAt`);
    if (t.kind !== tkind) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07: todayAt berbeda jenis dengan sumbu waktu`, { code: CODE });
    today = t.value;
  }
  const todayLabel = str(chartParam(spec, tpl, kindKey(CODE, "todayLabel"))) ?? "hari ini";

  const axis = timeAxis(tkind, [...items.flatMap((it) => [it.start, it.end]), ...(today !== undefined ? [today] : [])], gallery ? 4 : 8);

  const LBL = gallery ? 6.4 : 6.5;
  const TICK = gallery ? 6.0 : 6.5;
  const SPAN = 5.8;
  const MS = 6.2;
  const spanLabel = (it: Item): string => {
    if (tkind === "date") return `${timeValueLabel(tkind, it.start)}-${timeValueLabel(tkind, it.end)}`;
    const u = (spec.unit ?? "").toLowerCase();
    const body = `${timeValueLabel(tkind, it.start)}-${timeValueLabel(tkind, it.end)}`;
    return u === "" || u.startsWith("minggu") ? `M${body}` : body;
  };
  const labelW = Math.max(...rowLabels.map((s) => textWidthMm(s, LBL)));
  const x0 = Math.min(Math.max(labelW + 2.0, 6), W * 0.4);
  const rightNeed = Math.max(
    textWidthMm(axis.labels[axis.labels.length - 1] ?? "", TICK, tkind === "num" && !gallery ? "data" : "struct") / 2 + 0.3,
    ...items.map((it) => (it.milestone ? textWidthMm(it.label, MS) + 2.6 : gallery ? 0 : textWidthMm(spanLabel(it), SPAN, "data") + 1.0)),
  );
  // Milestone dan label rentang di ujung kanan sumbu dibiarkan menjorok ke talang kanan.
  const x1 = W - Math.max(1.0, rightNeed);
  const sx = linearScale(axis.min, axis.max, x0, x1);

  const showKey = !gallery && groups.length >= 2;
  let top = 1.6;
  if (showKey) top += 4.6;
  if (today !== undefined) top += 3.4;
  const base = f.bottom - 5.0;
  const step = (base - top) / Math.max(1, rowLabels.length);
  const bh = Math.min(step * 0.55, 6);
  const rowY = (row: number): number => top + step * (row + 0.5);

  if (showKey) keyRow(doc, 0, 3.4, groups.map((g) => ({ label: g, color: groupColour(g) })), pal, 6.2);

  // Grid x (datum, acuan grid_axis="x").
  if (!gallery) {
    for (const t of axis.ticks) doc.line(sx(t), top, sx(t), base, pal.ink200, 0.18, { attrs: ' data-grid="x"' });
  }
  // Label tugas = label tick sumbu y (PC:1206-1207 set_yticklabels); kontrak §3.5 data-axis (S79 E4).
  doc.open('data-axis="y"');
  rowLabels.forEach((s, r) => {
    if (s) doc.text(x0 - 1.2, mid(rowY(r), LBL), s, { sizePt: LBL, fill: gallery ? pal.ink400 : pal.ink700, anchor: "end" });
  });
  doc.close();

  let accentUsed = false;
  for (const it of items) {
    if (it.milestone) continue;
    const c = accented.has(it.index) ? pal.role.accent : groupColour(it.group);
    accentUsed = accentUsed || accented.has(it.index);
    const yc = rowY(it.row);
    const xa = sx(it.start);
    const xb = sx(it.end);
    doc.rect(xa, yc - bh / 2, Math.max(0.3, xb - xa), bh, c, { mark: { mark: "interval", series: it.group ?? it.label, index: it.index } });
    if (!gallery) doc.text(Math.max(xb, xa + 0.3) + 0.5, mid(yc, SPAN), spanLabel(it), { sizePt: SPAN, fill: pal.ink700, face: "data" });
  }
  for (const it of items) {
    if (!it.milestone) continue;
    const yc = rowY(it.row);
    const x = sx(it.start);
    const d = Math.min(bh * 0.62, 1.8);
    const c = accented.has(it.index) ? pal.role.accent : gallery || accentUsed ? pal.ink900 : pal.role.accent;
    doc.path(`M${num(x)} ${num(yc - d)} L${num(x + d)} ${num(yc)} L${num(x)} ${num(yc + d)} L${num(x - d)} ${num(yc)} Z`, c, {
      mark: { mark: "point", series: "milestone", index: it.index },
    });
    doc.text(x + d + 0.5, mid(yc, MS), it.label, { sizePt: MS, fill: c });
  }

  if (today !== undefined) {
    const xt = sx(today);
    doc.line(xt, top - 1.0, xt, base, pal.alert, 0.3, { dashMm: [0.6, 0.6], attrs: ' data-today="line"' });
    doc.text(xt, top - 1.8, todayLabel, { sizePt: 6.0, fill: pal.alert, anchor: "middle" });
  }

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, 0.25);
  axis.ticks.forEach((t, i) => doc.text(sx(t), base + 3.4, axis.labels[i], { sizePt: TICK, fill: pal.ink400, anchor: "middle", face: tkind === "num" && !gallery ? "data" : "struct" }));
  doc.close();
  if (!gallery && spec.unit) doc.text(W - 0.5, 2.4, spec.unit, { sizePt: 6.0, fill: pal.ink400, anchor: "end" });

  return closeFrame(f, spec);
}
