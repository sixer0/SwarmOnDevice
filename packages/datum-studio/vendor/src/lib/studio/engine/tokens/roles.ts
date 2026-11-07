/**
 * Format per peran (S11; 01_specs.md §5.6).
 *
 * Urutan resolusi: format eksplisit blok (di luar modul ini) > `roleFormats[role]`
 * versi templat > turunan katalog (`type.scale.*`, palet warna) > gaya Normal
 * templat (diterapkan lewat styles.xml S14, tidak disalin ke sini).
 *
 * Granularitas: `roleFormats[role]` menang per sub-objek (`para`, `run`,
 * `labelRun`, ...). Sub-objek yang ditulis templat dipakai utuh, tanpa atribut
 * katalog di bawahnya, agar profil terukur (Manual 000, S95) tidak mendapat
 * atribut yang tidak ada di sumbernya (mis. `caps` turunan).
 */
import type { FaceRole, ParaFormat, ParamMap, ParamValue, RoleFormat, RoleKey, RunProps } from "../../contract";
import { resolveColorToken } from "./color";

const FACE_ROLES: readonly FaceRole[] = ["serif", "condensed", "mono", "workbookUi", "symbolGlyph"];

interface RoleSpec {
  /** Unsur skala `type.scale.<el>` utama. */
  el: string;
  /** Unsur yang ditumpuk di atas `el` untuk run utama. */
  over?: string;
  jc?: ParaFormat["jc"];
  /** Run label: unsur dasar + kapital. */
  label?: { el: string; caps?: boolean; styleKey?: string };
  /** Run nomor: unsur dasar + tumpukan. */
  number?: { el: string; over?: string };
  /** Run penanda daftar dari parameter renderer. */
  markerKey?: string;
}

/** Peta peran -> unsur skala huruf katalog (Tabel 4.4 + unsur prosa P4T-X). */
const ROLE_SPECS: Readonly<Partial<Record<RoleKey, RoleSpec>>> = {
  "chapter.title": { el: "chapterTitle" },
  "part.title": { el: "chapterTitle" },
  "front.pageTitle": { el: "chapterTitle" },
  "toc.title": { el: "chapterTitle" },
  "chapter.kicker": { el: "chapterKicker" },
  "wrapper.kicker": { el: "chapterKicker" },
  "front.kicker": { el: "chapterKicker" },
  "section.heading": { el: "sectionHeading", number: { el: "sectionHeading", over: "sectionNumber" } },
  "body.paragraph": { el: "body" },
  "part.lede": { el: "body" },
  "controlSheet.methodStatement": { el: "body" },
  "derivation.intro": { el: "body" },
  "list.bullet": { el: "body", markerKey: "render.list.bulletMarker" },
  "list.number": { el: "body", markerKey: "render.list.numberMarker" },
  "aside.body": { el: "body", over: "asideBody" },
  "aside.label": { el: "tableHeader", label: { el: "tableHeader", styleKey: "type.scale.asideLabel.style" } },
  caption: { el: "caption", label: { el: "caption", styleKey: "caption.identifier.style" } },
  "table.cellText": { el: "tableBody" },
  "controlTable.cell": { el: "tableBody" },
  "toc.partTitle": { el: "tableBody" },
  "toc.chapterTitle": { el: "tableBody" },
  "part.chapterTitle": { el: "tableBody" },
  "table.cellMono": { el: "tableNumerals" },
  "toc.partPage": { el: "tableNumerals", jc: "right" },
  "toc.chapterPage": { el: "tableNumerals", jc: "right" },
  "part.chapterNo": { el: "tableNumerals" },
  "table.cellNumeralRight": { el: "tableNumerals", jc: "right" },
  "derivation.value": { el: "tableNumerals", jc: "right" },
  "table.headerLeft": { el: "tableHeader" },
  "controlTable.header": { el: "tableHeader" },
  "table.headerRight": { el: "tableHeader", jc: "right" },
  "table.groupBand": { el: "tableHeader", over: "groupBand" },
  "table.source": { el: "sourceLine", label: { el: "sourceLine", caps: true } },
  "figure.source": { el: "sourceLine", label: { el: "sourceLine", caps: true } },
  "rail.prose": { el: "evidenceRail" },
  "rail.mark": { el: "evidenceRail" },
  "rail.source": { el: "evidenceRail" },
  "rail.note": { el: "evidenceRail" },
  "derivation.expr": { el: "derivation" },
  "monoBlock.label": { el: "derivation" },
};

function get(p: ParamMap, el: string, attr: string): ParamValue | undefined {
  return p[`type.scale.${el}.${attr}`];
}

function numAttr(p: ParamMap, el: string, attr: string): number | undefined {
  const v = get(p, el, attr);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Mis. runningHead "400 (manual) / 500 (token)": ambil angka pertama.
  if (typeof v === "string") {
    const m = /\d+(?:[.,]\d+)?/.exec(v);
    if (m) return Number(m[0].replace(",", "."));
  }
  return undefined;
}

/** Tafsir gaya bebas "condensed 600", "condensed kapital", "condensedCaps", "mono". */
function styleRun(style: ParamValue | undefined): RunProps {
  if (typeof style !== "string") return {};
  const s = style.toLowerCase();
  const out: RunProps = {};
  const face = FACE_ROLES.find((f) => s.includes(f.toLowerCase()));
  if (face) out.faceRole = face;
  const w = /\b(\d{3})\b/.exec(s);
  if (w && Number(w[1]) >= 600) out.b = true;
  if (s.includes("kapital") || s.includes("caps")) out.caps = true;
  if (s.includes("italic") || s.includes("miring")) out.i = true;
  return out;
}

/** RunProps dari satu unsur skala; atribut yang tidak ada dilewati. */
export function scaleRun(p: ParamMap, el: string): RunProps {
  const out: RunProps = {};
  const size = numAttr(p, el, "size");
  if (size !== undefined) out.szHalfPt = Math.round(size * 2);
  const face = get(p, el, "face");
  const faceStyle = styleRun(face ?? get(p, el, "faceWeight"));
  if (faceStyle.faceRole) out.faceRole = faceStyle.faceRole;
  const weight = numAttr(p, el, "weight");
  if (weight !== undefined ? weight >= 600 : faceStyle.b) out.b = true;
  const colour = resolveColorToken(p, get(p, el, "colour"));
  if (colour) out.color = colour;
  if (get(p, el, "upper") === true) out.caps = true;
  const track = numAttr(p, el, "trackEm");
  if (track !== undefined && size !== undefined && track !== 0) out.spacingTw = Math.round(track * size * 20);
  return out;
}

/** ParaFormat dari satu unsur skala (leading -> spasi baris tepat). */
export function scalePara(p: ParamMap, el: string): ParaFormat {
  const leading = numAttr(p, el, "leading");
  return leading !== undefined ? { lineTw: Math.round(leading * 20), lineRule: "exact" } : {};
}

function markerRun(v: ParamValue | undefined): RunProps | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const { t: _t, ...rest } = v as Record<string, ParamValue>;
  void _t;
  return rest as RunProps;
}

function nonEmpty<T extends object>(o: T): T | undefined {
  return Object.keys(o).length > 0 ? o : undefined;
}

/** Format peran turunan katalog saja (tanpa `roleFormats` templat). */
export function catalogRoleFormat(p: ParamMap, role: RoleKey): RoleFormat {
  const spec = ROLE_SPECS[role];
  if (!spec) return {};
  const out: RoleFormat = {};
  const run = { ...scaleRun(p, spec.el), ...(spec.over ? scaleRun(p, spec.over) : {}) };
  const para: ParaFormat = { ...scalePara(p, spec.el), ...(spec.over ? scalePara(p, spec.over) : {}) };
  if (spec.jc) para.jc = spec.jc;
  if (nonEmpty(run)) out.run = run;
  if (nonEmpty(para)) out.para = para;
  if (spec.label) {
    const label: RunProps = { ...scaleRun(p, spec.label.el), ...(spec.label.styleKey ? styleRun(p[spec.label.styleKey]) : {}) };
    if (spec.label.caps) label.caps = true;
    if (nonEmpty(label)) out.labelRun = label;
  }
  if (spec.number) {
    const n = { ...scaleRun(p, spec.number.el), ...(spec.number.over ? scaleRun(p, spec.number.over) : {}) };
    if (nonEmpty(n)) out.numberRun = n;
  }
  if (spec.markerKey) {
    const m = markerRun(p[spec.markerKey]);
    if (m) {
      const color = resolveColorToken(p, m.color);
      out.markerRun = color ? { ...m, color } : m;
    }
  }
  return out;
}

/** `explicit` menang per sub-objek atas `base`. */
export function overlayRoleFormat(base: RoleFormat, explicit: RoleFormat | undefined): RoleFormat {
  if (!explicit) return base;
  const out: RoleFormat = { ...base };
  for (const k of Object.keys(explicit) as Array<keyof RoleFormat>) {
    if (explicit[k] !== undefined) (out as Record<string, unknown>)[k] = explicit[k];
  }
  return out;
}
