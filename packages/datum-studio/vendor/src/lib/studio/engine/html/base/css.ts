/**
 * CSS dasar dari token templat terselesaikan (S21; I10 `tokenCss`).
 *
 * Isi: properti khusus `:root` (warna, grid, garis, skala tipe), aturan
 * `@page` dari ukuran kertas efektif (KC-7: `pageSizeMm`, tanpa fallback A4)
 * + margin grid (atas 26 / bawah turunan D-33), dan kosakata kelas
 * dasar (acuan RL `Sumber Lembar Bukti.html`): `.page` (lembar), `.body`
 * (area isi grid), `.reg` (blok register), `.runhead`, `.t` (teks), `.r` (rel
 * bukti), moda rel A/B (`body.st-rail-a` / `body.st-rail-b`), `.datum`,
 * judul, tabel, derivasi, aside, figur, pembungkus. Tanpa URL, tanpa skrip.
 *
 * Nilai numerik dan warna dibaca dari parameter; konstanta yang tidak punya
 * parameter (tinggi blok register 8,5 mm, segmen garis datum, padding sel)
 * disalin dari acuan RL dan ditandai.
 */
import type { ResolvedTemplate } from "../../../contract";
import { normalizeHex, templateColorTokens } from "../../tokens";
import { cssString, roleFamily, type FaceRole } from "./fonts";
import { bool, colour, mm, num, P, pageGeometry, pt, r4, str } from "./params";

/** Unsur skala tipe (`type.scale.<el>.*`, P4T-S01..S13, X01..X11). */
export const TYPE_ELEMENTS = [
  "chapterTitle",
  "chapterKicker",
  "sectionHeading",
  "body",
  "tableBody",
  "tableNumerals",
  "tableHeader",
  "caption",
  "sourceLine",
  "evidenceRail",
  "runningHead",
  "registerBlock",
  "derivation",
  "groupBand",
  "unitColumn",
  "asideBody",
  "sectionNumber",
] as const;
export type TypeElement = (typeof TYPE_ELEMENTS)[number];

export interface TypeSpec {
  sizePt?: number;
  leadingPt?: number;
  role: FaceRole;
  weight: number;
  colour?: string;
  upper: boolean;
  trackEm?: number;
}

/** Cadangan skala bila parameter absen (katalog P4T, nilai default). */
const TYPE_FALLBACK: Readonly<Record<TypeElement, { sizePt: number; leadingPt?: number; role: FaceRole }>> = {
  chapterTitle: { sizePt: 16, leadingPt: 20, role: "condensed" },
  chapterKicker: { sizePt: 6.8, role: "condensed" },
  sectionHeading: { sizePt: 11, leadingPt: 13.5, role: "condensed" },
  body: { sizePt: 9.5, leadingPt: 13.5, role: "serif" },
  tableBody: { sizePt: 8.2, leadingPt: 11.5, role: "serif" },
  tableNumerals: { sizePt: 7.8, role: "mono" },
  tableHeader: { sizePt: 6.8, role: "condensed" },
  caption: { sizePt: 7.6, leadingPt: 11, role: "condensed" },
  sourceLine: { sizePt: 6.6, leadingPt: 9, role: "condensed" },
  evidenceRail: { sizePt: 5.9, leadingPt: 8.4, role: "mono" },
  runningHead: { sizePt: 6.8, role: "condensed" },
  registerBlock: { sizePt: 6.2, role: "mono" },
  derivation: { sizePt: 7.4, leadingPt: 11.5, role: "mono" },
  groupBand: { sizePt: 7.4, role: "condensed" },
  unitColumn: { sizePt: 7.2, role: "condensed" },
  asideBody: { sizePt: 8.6, leadingPt: 12.4, role: "serif" },
  sectionNumber: { sizePt: 8, role: "mono" },
};

function faceRoleOf(v: unknown): FaceRole | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.toLowerCase();
  if (s.includes("condensed") || s.includes("cond")) return "condensed";
  if (s.includes("mono")) return "mono";
  if (s.includes("workbook")) return "workbookUi";
  if (s.includes("serif")) return "serif";
  return undefined;
}

/** Spesifikasi satu unsur skala tipe dari parameter (`face`/`faceWeight`, `weight`, `upper`, `trackEm`, `colour`). */
export function typeSpec(tpl: ResolvedTemplate, el: TypeElement): TypeSpec {
  const p = tpl.params;
  const k = (a: string) => `type.scale.${el}.${a}`;
  const fb = TYPE_FALLBACK[el];
  const faceRaw = p[k("face")] ?? p[k("faceWeight")];
  const role = faceRoleOf(faceRaw) ?? fb.role;
  const wFromFace = typeof faceRaw === "string" ? /\b([1-9]00)\b/.exec(faceRaw)?.[1] : undefined;
  const weight = num(p, k("weight")) ?? (wFromFace ? Number(wFromFace) : el === "chapterTitle" || el === "sectionHeading" || el === "groupBand" ? 600 : 400);
  const colourRef = str(p, k("colour"));
  const styleRaw = str(p, k("style")) ?? "";
  return {
    sizePt: num(p, k("size")) ?? fb.sizePt,
    leadingPt: num(p, k("leading")) ?? fb.leadingPt,
    role,
    weight,
    colour: colourRef ? colour(tpl, colourRef, "2B3640") : undefined,
    upper: bool(p, k("upper")) ?? /kapital|caps/i.test(styleRaw),
    trackEm: num(p, k("trackEm")),
  };
}

const ROLE_FALLBACK_PARAM: Readonly<Record<FaceRole, { key: string; generic: string }>> = {
  serif: { key: P.fallbackReading, generic: "serif" },
  condensed: { key: P.fallbackStructural, generic: "sans-serif" },
  mono: { key: P.fallbackData, generic: "monospace" },
  workbookUi: { key: P.fallbackWorkbook, generic: "sans-serif" },
  symbolGlyph: { key: P.faceSymbol, generic: "sans-serif" },
};

/** Tumpukan fon literal: keluarga peran, glif simbol, fallback peran (P4T-10..13), generik. */
export function fontStack(tpl: ResolvedTemplate, role: FaceRole): string {
  const fams = [roleFamily(tpl, role)];
  const sym = roleFamily(tpl, "symbolGlyph");
  if (!fams.includes(sym)) fams.push(sym);
  const fb = ROLE_FALLBACK_PARAM[role];
  const sys = str(tpl.params, fb.key);
  if (sys && sys.trim() && !fams.includes(sys.trim())) fams.push(sys.trim());
  return [...fams.map(cssString), fb.generic].join(",");
}

function ruleMm(tpl: ResolvedTemplate, key: string, fallback: number): string {
  return mm(num(tpl.params, key) ?? fallback);
}

function ruleColour(tpl: ResolvedTemplate, key: string, fallback: string): string {
  return colour(tpl, str(tpl.params, key), fallback);
}

/** Properti khusus `:root`, urutan tetap (deterministik). */
export function tokenVars(tpl: ResolvedTemplate): Array<[string, string]> {
  const p = tpl.params;
  const g = pageGeometry(tpl);
  const vars: Array<[string, string]> = [];
  const add = (n: string, v: string) => vars.push([n, v]);

  // Warna palet: interior (--<nama>), pembungkus (--w-<nama>), brief (--b-<nama>).
  const groups: Array<[string, string]> = [
    ["color.interior.", "--"],
    ["color.wrapper.", "--w-"],
    ["color.brief.", "--b-"],
  ];
  for (const [prefix, vp] of groups) {
    for (const key of Object.keys(p).filter((k) => k.startsWith(prefix)).sort()) {
      const hex = normalizeHex(p[key]);
      if (hex) add(`${vp}${key.slice(prefix.length).replace(/[^A-Za-z0-9_-]/g, "-")}`, `#${hex}`);
    }
  }
  for (const [t, hex] of Object.entries(templateColorTokens(tpl))) add(`--${t}`, `#${hex}`);
  for (const key of Object.keys(p).filter((k) => k.startsWith("color.role.")).sort()) {
    add(`--role-${key.slice("color.role.".length)}`, colour(tpl, key, "2B3640"));
  }
  for (const m of ["terukur", "diturunkan", "pemasok", "asumsi"]) {
    add(`--mark-${m}`, colour(tpl, str(p, `marks.${m}.colour`), "101418"));
  }
  add("--seal-band", colour(tpl, str(p, P.sealColour) ?? "seal", "6E1420"));
  // Swarm patch (row 49a, C104 H1): Rev A DT-28d classification ink = seal (was alert); shell.ts :root sets the per-level value.
  add("--class-ink", colour(tpl, "seal", "6E1420"));

  // Grid dan lembar (P4G, D-33).
  add("--page-w", mm(g.pageW));
  add("--page-h", mm(g.pageH));
  add("--m-top", mm(g.top));
  add("--m-bottom", mm(g.bottom));
  add("--m-inner", mm(g.inner));
  add("--m-outer", mm(g.outer));
  add("--col", mm(g.text));
  add("--gut", mm(g.gutter));
  add("--rail", mm(g.rail));
  add("--full", mm(g.fullSpan));
  add("--pitch", mm(g.pitchX));
  add("--pitch-y", mm(g.pitchY));
  add("--hdr", mm(g.headerMm));
  add("--ftr", mm(g.footerMm));
  add("--baseline", pt(num(p, P.baselinePt) ?? 13.5));
  add("--seal-h", ruleMm(tpl, P.sealHeight, 5));
  // G-02 cover.title.sizePt (24-26); leading = ukuran x 29/26 (rasio acuan RL 26/29 pt).
  const coverPt = num(p, "cover.title.sizePt") ?? 24;
  add("--fs-coverTitle", pt(coverPt));
  add("--lh-coverTitle", pt((coverPt * 29) / 26));

  // Garis (P4R) dan perangkat garis datum (P4S-01..04).
  add("--rule-primary", ruleMm(tpl, "rules.primaryMm", 0.45));
  add("--rule-primary-c", ruleColour(tpl, "rules.primary.colour", "101418"));
  add("--rule-header", ruleMm(tpl, "rules.belowHeaderMm", 0.25));
  add("--rule-header-c", ruleColour(tpl, "rules.belowHeader.colour", "6B7783"));
  add("--rule-hair", ruleMm(tpl, "rules.hairMm", 0.2));
  add("--rule-hair-c", ruleColour(tpl, "rules.hair.colour", "C3CBD1"));
  add("--rule-rev", ruleMm(tpl, "rules.revisionBarMm", 0.5));
  add("--rule-rev-c", ruleColour(tpl, "rules.revisionBar.colour", "101418"));
  add("--rule-aside", ruleMm(tpl, "rules.asideTopMm", 0.35));
  add("--rule-der", ruleMm(tpl, "rules.derivationLeftMm", 0.45));
  add("--rule-der-c", ruleColour(tpl, "rules.derivationLeft.colour", "B45309"));
  add("--datum-w", ruleMm(tpl, P.datumWeight, 0.2));
  add("--datum-front", ruleMm(tpl, P.datumFront, 9));
  // Variabel rel yang dibaca CSS struktural S22 (`.st-railhost`).
  add("--st-rail-width", "var(--rail)");
  add("--st-rail-gap", "var(--gut)");

  // Fon dan pelacakan.
  for (const role of ["serif", "condensed", "mono", "workbookUi"] as const) add(`--ff-${role}`, fontStack(tpl, role));
  add("--track-display", `${r4(num(p, P.trackDisplay) ?? -0.012)}em`);
  add("--track-micro", `${r4(num(p, P.trackMicro) ?? 0.09)}em`);
  add("--align-body", str(p, P.bodyAlign) === "left" ? "left" : "justify");

  // Skala tipe per unsur.
  for (const el of TYPE_ELEMENTS) {
    const s = typeSpec(tpl, el);
    if (s.sizePt !== undefined) add(`--fs-${el}`, pt(s.sizePt));
    if (s.leadingPt !== undefined) add(`--lh-${el}`, pt(s.leadingPt));
    add(`--ff-${el}`, `var(--ff-${s.role})`);
    add(`--fw-${el}`, String(s.weight));
    if (s.colour) add(`--fc-${el}`, s.colour);
    add(`--tt-${el}`, s.upper ? "uppercase" : "none");
    if (s.trackEm !== undefined) add(`--ls-${el}`, `${r4(s.trackEm)}em`);
  }
  return vars;
}

/**
 * Aturan statis yang hanya merujuk properti khusus. Konstanta tanpa parameter
 * disalin dari acuan RL (Sumber Lembar Bukti.html) dan ditandai `RL`.
 */
const BASE_RULES = String.raw`
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--paper);color:var(--fc-body,var(--ink700));font-family:var(--ff-body);font-size:var(--fs-body);line-height:var(--lh-body);
  counter-reset:st-sheet;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
p,h1,h2,h3,h4,figure,pre,table,blockquote{margin:0;padding:0}

/* ===== lembar (.page) — mode berhalaman, dibaca S25 measure ===== */
.page{position:relative;width:var(--page-w);height:var(--page-h);overflow:hidden;background:var(--paper);color:var(--fc-body,var(--ink700));
  counter-increment:st-sheet;break-after:page;page:st-sheet}
.page:last-child{break-after:auto}
.page.wrap{background:var(--w-paper);color:var(--w-body)}

/* ===== alir (.st-unit) — mode tanpa lembar; cetak dipaginasi @page + kotak margin ===== */
.st-unit{position:relative;counter-increment:st-sheet}
.st-unit + .st-unit{break-before:page}
.st-unit > .runhead.st-screen,.st-unit > .reg.st-screen{display:none}

/* ===== running head ===== */
.runhead{position:absolute;left:var(--m-inner);right:var(--m-outer);top:var(--hdr);display:flex;justify-content:space-between;gap:4mm;
  font-family:var(--ff-runningHead);font-size:var(--fs-runningHead);font-weight:var(--fw-runningHead);letter-spacing:var(--track-micro);
  text-transform:var(--tt-runningHead);color:var(--fc-runningHead);padding-bottom:1.6mm;border-bottom:var(--rule-hair) solid var(--rule-hair-c);
  white-space:nowrap}
.runhead > span{overflow:hidden;text-overflow:ellipsis}
.runhead .cls{color:var(--class-ink);font-weight:600}

/* ===== blok register (perangkat #3); tinggi 8,5 mm dan sel 5,4 mm = RL ===== */
.reg{position:absolute;left:var(--m-inner);right:var(--m-outer);bottom:var(--ftr);height:8.5mm;display:grid;grid-template-columns:1fr 1fr 1fr auto;
  align-items:center;border-top:var(--rule-aside) solid var(--ink900);border-bottom:var(--rule-hair) solid var(--rule-hair-c);
  font-family:var(--ff-registerBlock);font-size:var(--fs-registerBlock);font-weight:var(--fw-registerBlock);letter-spacing:.02em;
  color:var(--fc-registerBlock);white-space:nowrap}
.reg > div{padding:0 2.5mm;border-right:var(--rule-hair) solid var(--rule-hair-c);height:5.4mm;display:flex;align-items:center;gap:.6em}
.reg > div:first-child{padding-left:0}
.reg > div:last-child{border-right:0;padding-right:0;color:var(--class-ink);font-weight:600}
.reg b{color:var(--ink900);font-weight:600}
.reg .cls{color:var(--class-ink);font-weight:600}
.reg .st-sheet-n::before{content:counter(st-sheet)}
.reg .st-sheet-total::before{content:var(--st-sheets,"")}

/* ===== garis datum (perangkat #1); tinggi tik 1,15 mm dan segmen depan 0,75 mm = RL ===== */
.datum{position:relative;display:block;height:2.4mm;margin-bottom:2.2mm}
.datum::before{content:"";position:absolute;left:0;right:0;top:0;height:var(--datum-w);background:var(--ink900)}
.datum::after{content:"";position:absolute;left:0;top:0;width:var(--datum-front);height:.75mm;background:var(--ink900)}
.datum i{position:absolute;left:0;top:var(--datum-w);height:1.15mm;width:100%;
  background-image:repeating-linear-gradient(to right,var(--ink900) 0 .17mm,transparent .17mm var(--pitch))}
.datum.w::before,.datum.w::after{background:var(--w-ink)}
.datum.w i{background-image:repeating-linear-gradient(to right,var(--w-ink) 0 .17mm,transparent .17mm var(--pitch))}

/* ===== grid badan + rel bukti (perangkat #2) ===== */
.body{display:grid;grid-template-columns:var(--col) var(--gut) var(--rail);align-content:start}
.page .body{position:absolute;left:var(--m-inner);right:var(--m-outer);top:var(--m-top);bottom:var(--m-bottom)}
.body > *{grid-column:1;min-width:0}
.body > .span,.body > h1,.body > .tbl,.body > .fig,.body > .sp{grid-column:1 / -1}
.body > .tbl.narrow,.body > .fig.narrow{grid-column:1}
.t{font-family:var(--ff-body);font-size:var(--fs-body);line-height:var(--lh-body);font-weight:var(--fw-body);color:var(--fc-body);
  text-align:var(--align-body);hyphens:auto}
.body > .r{grid-column:3}
.r{font-family:var(--ff-evidenceRail);font-size:var(--fs-evidenceRail);line-height:var(--lh-evidenceRail);color:var(--fc-evidenceRail);
  letter-spacing:.02em;text-transform:var(--tt-evidenceRail);padding-top:1.2pt;overflow-wrap:anywhere}
.r .g{color:var(--mark-terukur);font-weight:600}
.r .d{color:var(--mark-diturunkan);font-weight:600}
.r .v{color:var(--mark-pemasok);font-weight:600}
.r .a{color:var(--mark-asumsi);font-weight:600}
.r em{display:block;font-style:normal;text-transform:none;letter-spacing:0;margin-top:.6mm}
.r.rev{border-right:var(--rule-rev) solid var(--rule-rev-c);padding-right:2mm;margin-right:-2mm}
/* moda B: tanpa kolom rel; rel ditaruh di bawah paragrafnya, selebar bentang penuh */
.st-rail-b .body{grid-template-columns:var(--full)}
.st-rail-b .body > *,.st-rail-b .body > .r{grid-column:1}
.st-rail-b .r{margin:.8mm 0 1.6mm;padding-top:0}
.sp{height:var(--baseline)}
.sp.h{height:calc(var(--baseline) / 2)}

/* ===== judul (kosakata RL di dalam .body; S22 memakai kelas st-*) ===== */
.body > h1{font-family:var(--ff-chapterTitle);font-weight:var(--fw-chapterTitle);font-size:var(--fs-chapterTitle);line-height:var(--lh-chapterTitle);
  color:var(--fc-chapterTitle);letter-spacing:var(--track-display);margin-bottom:4pt}
.body > h1 .kick{display:block;font-family:var(--ff-chapterKicker);font-size:var(--fs-chapterKicker);font-weight:var(--fw-chapterKicker);
  letter-spacing:var(--ls-chapterKicker);color:var(--fc-chapterKicker);text-transform:var(--tt-chapterKicker);margin-bottom:2.4mm}
.body > h2{font-family:var(--ff-sectionHeading);font-weight:var(--fw-sectionHeading);font-size:var(--fs-sectionHeading);line-height:var(--lh-sectionHeading);
  color:var(--fc-sectionHeading);margin:var(--baseline) 0 4pt 0}
.body > h2 > span:first-child,.body > h3 > span:first-child{font-family:var(--ff-sectionNumber);font-size:var(--fs-sectionNumber);font-weight:500;
  color:var(--fc-sectionNumber);margin-right:2.5mm}
.body > h3{font-family:var(--ff-sectionHeading);font-weight:var(--fw-sectionHeading);font-size:var(--fs-body);line-height:var(--lh-body);
  color:var(--fc-sectionHeading);margin:9pt 0 1pt 0;letter-spacing:.01em}

/* ===== tabel (kosakata RL .tbl; tabel S23 bergaya inline, tidak tersentuh) ===== */
.tbl{margin-top:6pt}
.tcap,.fcap{display:block;font-family:var(--ff-caption);font-size:var(--fs-caption);line-height:var(--lh-caption);color:var(--fc-caption)}
.tcap{margin-bottom:2.2mm}
.tcap b,.fcap b{font-weight:600;color:var(--ink900);letter-spacing:.05em;text-transform:uppercase;margin-right:3mm}
.tbl table,.wtbl,.ctrl table{width:100%;border-collapse:collapse;font-family:var(--ff-tableBody);font-size:var(--fs-tableBody);line-height:var(--lh-tableBody);color:var(--fc-tableBody)}
.tbl thead th{font-family:var(--ff-tableHeader);font-size:var(--fs-tableHeader);font-weight:var(--fw-tableHeader);letter-spacing:var(--ls-tableHeader);
  text-transform:var(--tt-tableHeader);color:var(--fc-tableHeader);text-align:left;padding:1.6mm 2.5mm 1.6mm 0;vertical-align:bottom;
  border-top:var(--rule-primary) solid var(--rule-primary-c);border-bottom:var(--rule-header) solid var(--rule-header-c)}
.tbl tbody td{padding:1.5mm 2.5mm 1.5mm 0;vertical-align:top;border-bottom:var(--rule-hair) solid var(--rule-hair-c)}
.tbl tbody tr:last-child td{border-bottom:0}
.tbl tbody tr.zebra td{background:var(--role-zebra)}
.tbl tfoot td{padding:1.8mm 2.5mm 1.4mm 0;border-top:var(--rule-primary) solid var(--rule-primary-c);font-weight:600;color:var(--ink900);
  font-family:var(--ff-condensed)}
.tbl .num{font-family:var(--ff-tableNumerals);font-size:var(--fs-tableNumerals);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;
  color:var(--fc-tableNumerals)}
.tbl .unit{font-family:var(--ff-unitColumn);font-size:var(--fs-unitColumn);color:var(--fc-unitColumn);white-space:nowrap}
.tbl .idc{font-family:var(--ff-mono);font-size:var(--fs-tableNumerals);color:var(--ink400)}
.tbl .grp td{padding-top:3.2mm;padding-bottom:1mm;font-family:var(--ff-groupBand);font-weight:var(--fw-groupBand);font-size:var(--fs-groupBand);
  letter-spacing:.08em;text-transform:var(--tt-groupBand);color:var(--fc-groupBand)}
.tbl .src,.fig .src{font-family:var(--ff-sourceLine);font-size:var(--fs-sourceLine);line-height:var(--lh-sourceLine);color:var(--fc-sourceLine);font-style:normal;
  margin-top:2.2mm;padding-top:1.6mm;border-top:var(--rule-hair) solid var(--rule-hair-c)}
.tbl .src b,.fig .src b{font-weight:600;letter-spacing:.08em;text-transform:uppercase}

/* ===== derivasi, aside, figur ===== */
.der{margin:8pt 0 4pt 0;padding-left:4.5mm;border-left:var(--rule-der) solid var(--rule-der-c)}
.der .lbl,.aside .lbl{font-family:var(--ff-condensed);font-size:var(--fs-sourceLine);font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-bottom:1.8mm}
.der .lbl{color:var(--rule-der-c)}
.der pre{font-family:var(--ff-derivation);font-size:var(--fs-derivation);line-height:var(--lh-derivation);color:var(--fc-derivation);white-space:pre;
  font-variant-numeric:tabular-nums}
.der .note{font-family:var(--ff-condensed);font-size:var(--fs-unitColumn);line-height:1.4;color:var(--ink400);margin-top:1.8mm}
.aside{margin:8pt 0 2pt 0;padding:3mm 0;border-top:var(--rule-aside) solid var(--ink900);border-bottom:var(--rule-hair) solid var(--rule-hair-c)}
.aside .lbl{color:var(--ink900)}
.aside p{font-size:var(--fs-asideBody);line-height:var(--lh-asideBody)}
.fig{margin-top:6pt}
.fig svg,.fig img{display:block;max-width:100%;height:auto}
.fcap{margin-top:3mm;padding-top:2mm;border-top:var(--rule-hair) solid var(--rule-hair-c)}

/* ===== pembungkus (sampul, lembar kendali) ===== */
.sealband{position:absolute;left:0;right:0;top:0;height:var(--seal-h);background:var(--seal-band);display:flex;align-items:center;
  justify-content:space-between;padding:0 var(--m-outer) 0 var(--m-inner);font-family:var(--ff-condensed);font-size:6.4pt;font-weight:600;
  letter-spacing:.22em;color:var(--w-cream);text-transform:uppercase}
.cvr,.wbody{position:absolute;left:var(--m-inner);right:var(--m-outer)}
.cvr{top:40mm}
.wbody{top:var(--m-top);bottom:var(--m-bottom)}
.ctype{font-family:var(--ff-condensed);font-size:7.4pt;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--w-seal);margin-bottom:5mm}
.ctitle{font-family:var(--ff-condensed);font-weight:600;font-size:var(--fs-coverTitle);line-height:var(--lh-coverTitle);color:var(--w-ink);letter-spacing:var(--track-display);max-width:150mm}
.csub{font-family:var(--ff-serif);font-style:italic;font-size:11pt;line-height:15pt;color:var(--w-body);margin-top:6mm;max-width:140mm}
.cscope,.orgline{font-family:var(--ff-condensed);font-size:7.4pt;line-height:12pt;color:var(--w-meta);letter-spacing:.03em}
.ctrl{position:absolute;left:var(--m-inner);right:var(--m-outer);bottom:var(--m-top)}
.cfoot{position:absolute;left:var(--m-inner);right:var(--m-outer);bottom:var(--ftr);font-family:var(--ff-mono);font-size:var(--fs-registerBlock);
  color:var(--w-meta);display:flex;justify-content:space-between;padding-top:2mm;border-top:var(--rule-hair) solid var(--w-rule)}
.cfoot .c{color:var(--w-seal);font-weight:600}
.spine{position:absolute;right:6mm;top:14mm;bottom:var(--m-top);display:flex;align-items:center;font-family:var(--ff-mono);font-size:6pt;
  letter-spacing:.06em;color:var(--w-meta);writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg)}
.wh1{font-family:var(--ff-condensed);font-weight:600;font-size:15pt;line-height:19pt;color:var(--w-ink);margin-bottom:5mm}
.wh2{font-family:var(--ff-condensed);font-weight:600;font-size:10pt;color:var(--w-ink);margin:0 0 3mm 0;letter-spacing:.02em}
.wp{font-size:9pt;line-height:13pt;color:var(--w-body);text-align:var(--align-body);max-width:150mm;margin-bottom:4mm}
.wtbl{width:100%;font-size:7.8pt;line-height:11pt;margin-bottom:9mm;color:var(--w-body)}
.wtbl th{font-family:var(--ff-condensed);font-size:6.4pt;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--w-meta);text-align:left;
  padding:1.6mm 3mm 1.6mm 0;border-top:var(--rule-primary) solid var(--w-ink);border-bottom:var(--rule-hair) solid var(--w-meta)}
.wtbl td{padding:1.5mm 3mm 1.5mm 0;border-bottom:var(--rule-hair) solid var(--w-rule);vertical-align:top}
.wtbl td.mono,.ctrl td.mono{font-family:var(--ff-mono);color:var(--w-ink);font-variant-numeric:tabular-nums}
.stmt{border-top:var(--rule-primary) solid var(--w-ink);border-bottom:var(--rule-hair) solid var(--w-rule);padding:4mm 0;margin-top:6mm}
.sig{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8mm;margin-top:14mm}
.sig > div{border-top:var(--rule-hair) solid var(--w-meta);padding-top:2mm;font-family:var(--ff-condensed);font-size:6.6pt;letter-spacing:.1em;
  text-transform:uppercase;color:var(--w-meta)}
.sig > div b{display:block;font-family:var(--ff-serif);font-size:8.4pt;letter-spacing:0;text-transform:none;color:var(--w-ink);font-weight:600;margin-top:1mm}

/* ===== kosakata S22/S24 (D-45): unit alir, rel, teks; CSS struktural S24 disisipkan sebelum ini ===== */
.st-unit.st-unit-cover,.st-unit.st-unit-controlSheet,.st-unit.st-unit-part{background:var(--w-paper);color:var(--w-body)}
.st-rail{font-family:var(--ff-evidenceRail);font-size:var(--fs-evidenceRail);line-height:var(--lh-evidenceRail);color:var(--fc-evidenceRail);
  letter-spacing:.02em;text-transform:var(--tt-evidenceRail);overflow-wrap:anywhere}
.st-rail-a :is(.st-p,.st-list,.st-aside,.st-monoblock,.st-asm,.st-section-heading):not(.st-railhost *){max-width:var(--col)}
.st-rail-b .st-railhost{grid-template-columns:minmax(0,1fr);row-gap:.8mm}
.st-p{text-align:var(--align-body);hyphens:auto}

/* ===== label pratinjau (layar saja) ===== */
.st-preview-label{display:none}

@media screen{
  body.st-doc{background:var(--ink200)}
  .page{margin:10mm auto}
  .st-unit{width:var(--page-w);min-height:var(--page-h);margin:10mm auto;padding:var(--m-top) var(--m-outer) var(--m-bottom) var(--m-inner);background:var(--paper)}
  .st-unit > .runhead.st-screen,.st-unit > .reg.st-screen{display:grid}
  .st-unit > .runhead.st-screen{display:flex}
  .st-preview-label{display:block;position:sticky;top:0;z-index:10;padding:1.6mm var(--m-outer) 1.6mm var(--m-inner);background:var(--ink900);
    color:var(--paper);font-family:var(--ff-condensed);font-size:7pt;font-weight:600;letter-spacing:.16em;text-transform:uppercase;text-align:center}
}
@media print{
  body.st-doc{background:none}
  .st-unit{width:auto;min-height:0;margin:0;padding:0}
}
`;

/** Aturan `@page` dari grid: halaman alir memakai margin grid; lembar `.page` bermargin nol. */
export function pageRulesCss(tpl: ResolvedTemplate): string {
  const g = pageGeometry(tpl);
  const size = `${mm(g.pageW)} ${mm(g.pageH)}`;
  return [
    `@page{size:${size};margin:${mm(g.top)} ${mm(g.outer)} ${mm(g.bottom)} ${mm(g.inner)}}`,
    `@page st-sheet{size:${size};margin:0}`,
  ].join("\n");
}

/** CSS token lengkap: `:root` + `@page` + aturan dasar. Deterministik untuk templat yang sama. */
export function buildTokenCss(tpl: ResolvedTemplate): string {
  const vars = tokenVars(tpl)
    .map(([n, v]) => `  ${n}:${v};`)
    .join("\n");
  return `:root{\n${vars}\n}\n${pageRulesCss(tpl)}\n${BASE_RULES.trim()}\n`;
}
