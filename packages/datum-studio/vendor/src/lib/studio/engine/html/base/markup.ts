/**
 * Markup perabot halaman (S21): running head, blok register "LEMBAR n DARI N",
 * pembungkus lembar `.page`.
 *
 * Dua mode tata letak, keduanya tanpa skrip:
 * - Berhalaman (`pageSheet`): satu `.page` = satu lembar A4 tetap, isi di
 *   `.body`, register di `.reg`; n = penghitung CSS `st-sheet`, N = jumlah
 *   lembar yang dihitung `htmlShell` (properti `--st-sheets`). Konvensi markup
 *   ini dibaca S25 `measure.ts` (D-38).
 * - Alir (unit `.st-unit` buatan S24, D-45): isi mengalir, Chromium
 *   memaginasi lewat `@page` margin grid; running head dan register dicetak
 *   di kotak margin `@page` dengan `counter(page)` / `counter(pages)`
 *   (disusun `htmlShell`). Di layar setiap unit tampil sebagai satu lembar
 *   galai dengan salinan perabot `.st-screen` yang disisipkan `htmlShell`.
 */
import type { DocMeta, ResolvedTemplate } from "../../../contract";
import { classificationMarkText, registerWordsText } from "../../front/texts";
import { classificationCode, list, P, registerDate, str } from "./params";

/**
 * Escape teks untuk isi elemen dan nilai atribut berkutip. Karakter kendali C0
 * (kecuali tab, LF, CR) dibuang karena tidak sah di HTML (S72 F-S72-2; sama
 * dengan `escapeHtml` engine/html/blocks).
 */
export function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RunningHeadText {
  left: string;
  center: string;
  right: string;
}

export interface ChapterRef {
  /** Nomor bab apa adanya (mis. "5", "A"). */
  n: string | number;
  title: string;
}

/** Label klasifikasi untuk tampilan (kode SR/R/T/B diperluas, label dipertahankan). */
export function classificationLabel(meta: Pick<DocMeta, "classification">): string {
  const code = classificationCode(meta.classification);
  const raw = meta.classification.trim();
  if (raw.length > 2 || !code) return raw;
  return { SR: "Sangat Rahasia", R: "Rahasia", T: "Terbatas", B: "Biasa" }[code] ?? raw;
}

/**
 * Teks running head dari `runningHead.fields` (P4A-01): "entitas" ->
 * `org.entityName`, "jenis dokumen" -> `cover.kicker.text` (cadangan
 * `meta.typeCode`), medan berpola `{n}` / "judul bab" -> tengah (butuh
 * `chapter`), klasifikasi di kanan (P4A-02). `override` menimpa per posisi.
 */
export function runningHeadText(
  tpl: ResolvedTemplate,
  meta: DocMeta,
  chapter?: ChapterRef,
  override?: Partial<RunningHeadText>,
): RunningHeadText {
  const p = tpl.params;
  const fields = list(p, "runningHead.fields").filter((f): f is string => typeof f === "string");
  const left: string[] = [];
  const center: string[] = [];
  for (const f of fields.length > 0 ? fields : ["entitas", "jenis dokumen", "BAB {n}", "judul bab"]) {
    const k = f.toLowerCase();
    if (k === "entitas") {
      const e = str(p, P.entity);
      if (e) left.push(e);
    } else if (k === "jenis dokumen") {
      const t = str(p, P.kickerText)?.trim() || meta.typeCode;
      if (t) left.push(t);
    } else if (f.includes("{n}")) {
      if (chapter) center.push(f.replace(/\{n\}/g, String(chapter.n)));
    } else if (k === "judul bab") {
      if (chapter?.title) center.push(chapter.title);
    } else if (f.trim()) {
      left.push(f.trim());
    }
  }
  const cls = classificationMarkText(classificationLabel(meta));
  const pos = str(p, "runningHead.classification.position") ?? "right";
  const base: RunningHeadText = {
    left: (pos === "left" ? [cls, ...left] : left).join(" · "),
    center: center.join(" · "),
    right: pos === "left" ? "" : cls,
  };
  return { ...base, ...override };
}

export function runningHeadHtml(t: RunningHeadText, extraClass = ""): string {
  const cls = `runhead${extraClass ? ` ${extraClass}` : ""}`;
  return `<div class="${cls}"><span>${esc(t.left)}</span><span>${esc(t.center)}</span><span class="cls">${esc(t.right)}</span></div>`;
}

/** Potongan sel register: teks literal atau medan. */
type CellPart = { text: string } | { field: "org" | "nomor" | "rev" | "tanggal" | "n" | "N" | "kelas"; bold: boolean };

/** Nama medan P4S-13 (enum SR-05 KT-6) + alias pendek; paritas DOCX `REGISTER_BOLD_ALIASES` (IP-44/IP-50). */
const FIELD_ALIASES: Readonly<Record<string, CellPart extends infer T ? (T extends { field: infer F } ? F : never) : never>> = {
  "nomor dokumen": "nomor",
  nomor: "nomor",
  "nomor lembar": "n",
  lembar: "n",
  "jumlah lembar": "N",
  revisi: "rev",
  rev: "rev",
  tanggal: "tanggal",
  kelas: "kelas",
  klasifikasi: "kelas",
  organisasi: "org",
  org: "org",
};

const PLACEHOLDER = /\{(org|nomor|rev|tanggal|n|N|kelas)\}/g;

/** Cadangan P4S-11 (sama dengan registri dan DOCX `REGISTER_CELLS_FALLBACK`). */
const REGISTER_CELLS_FALLBACK: readonly string[] = ["GSP · {nomor}", "REV · {tanggal}", "LEMBAR {n} DARI {N}", "{kelas}"];
/** Pola bawaan registri berliteral "GSP" dibaca "{org} · {nomor}" (paritas DOCX RQ-6). */
const REGISTER_ORG_CELL_LEGACY = "GSP · {nomor}";
/** Cadangan P4S-12: spasi tak-putus U+00A0 (BM footer5.xml). */
const REGISTER_SEPARATOR_FALLBACK = "\u00A0";

/**
 * Sel blok register dari `device.registerBlock.cells` (P4S-11), medan tebal
 * dari `device.registerBlock.boldFields` (P4S-13). Sel berawalan "REV" tanpa
 * `{rev}` mendapat huruf revisi setelah "REV" (acuan RL: "REV B · 31-VII-2026").
 * Paritas DOCX (RQ-6/RQ-5): medan `{org}` = `org.shortName` (pola bawaan
 * "GSP · {nomor}" dibaca "{org} · {nomor}"), spasi ASCII pada teks literal
 * diganti `device.registerBlock.separator` (P4S-12, bawaan NBSP), dan untuk
 * dokumen EN kata LEMBAR/DARI menjadi SHEET/OF.
 */
export function registerCellParts(tpl: ResolvedTemplate, language?: DocMeta["language"]): CellPart[][] {
  const p = tpl.params;
  const raw = list(p, P.registerCells).filter((c): c is string => typeof c === "string" && c.length > 0);
  const cells = (raw.length > 0 ? raw : REGISTER_CELLS_FALLBACK).map((c) => (c === REGISTER_ORG_CELL_LEGACY ? "{org} · {nomor}" : c));
  const sep = str(p, P.registerSeparator) ?? REGISTER_SEPARATOR_FALLBACK;
  // Kata label LEMBAR/DARI: tabel bersama DOCX/HTML `front/texts.ts` (S06 B-11).
  const lang = language === "EN" ? "EN" : "ID";
  const literal = (t: string): string => registerWordsText(t, lang).replace(/ /g, sep);
  const bold = new Set(
    list(p, P.registerBold)
      .filter((b): b is string => typeof b === "string")
      .map((b) => FIELD_ALIASES[b.trim().toLowerCase()])
      .filter(Boolean),
  );
  return cells.map((c0) => {
    const c = /^REV\b/.test(c0) && !c0.includes("{rev}") ? c0.replace(/^REV\b/, "REV {rev}") : c0;
    const parts: CellPart[] = [];
    let last = 0;
    for (const m of c.matchAll(PLACEHOLDER)) {
      if (m.index > last) parts.push({ text: literal(c.slice(last, m.index)) });
      const field = m[1] as Extract<CellPart, { field: string }>["field"];
      parts.push({ field, bold: bold.has(field) });
      last = m.index + m[0].length;
    }
    if (last < c.length) parts.push({ text: literal(c.slice(last)) });
    return parts;
  });
}

/** Nilai medan register yang tidak bergantung halaman (`tpl` untuk `{org}` = `org.shortName`, bawaan "GSP"). */
export function registerFieldValue(meta: DocMeta, field: "org" | "nomor" | "rev" | "tanggal" | "kelas", tpl?: ResolvedTemplate): string {
  switch (field) {
    case "org":
      return (tpl ? str(tpl.params, P.orgShort)?.trim() : undefined) || "GSP";
    case "nomor":
      return meta.docNumber?.trim() || "—";
    case "rev":
      return meta.rev;
    case "tanggal":
      return registerDate(meta.issueDate);
    case "kelas":
      return classificationMarkText(classificationLabel(meta));
  }
}

/** Blok register mode berhalaman: n = `counter(st-sheet)`, N = `var(--st-sheets)`. */
export function registerHtml(tpl: ResolvedTemplate, meta: DocMeta, extraClass = ""): string {
  const cells = registerCellParts(tpl, meta.language).map((parts) => {
    const inner = parts
      .map((part) => {
        if ("text" in part) return esc(part.text);
        let v: string;
        if (part.field === "n") v = `<span class="st-sheet-n"></span>`;
        else if (part.field === "N") v = `<span class="st-sheet-total"></span>`;
        else v = esc(registerFieldValue(meta, part.field, tpl));
        // Swarm patch (row 49a, C104 H1): {kelas} is always bold in the classification ink (Rev A DT-28d seal), as the
        // DOCX register run; before, a bold {kelas} took `.reg b` ink900 over the last cell's class ink.
        if (part.field === "kelas") return `<b class="cls">${v}</b>`;
        return part.bold ? `<b>${v}</b>` : v;
      })
      .join("");
    return `<div>${inner}</div>`;
  });
  const cls = `reg${extraClass ? ` ${extraClass}` : ""}`;
  return `<div class="${cls}">${cells.join("")}</div>`;
}

export interface PageSheetInput {
  tpl: ResolvedTemplate;
  meta: DocMeta;
  /** Isi lembar (HTML siap; sudah di-escape oleh perender blok). */
  bodyHtml: string;
  /** `wrapper` = palet pembungkus (sampul, lembar kendali), tanpa perabot interior bawaan. */
  kind?: "interior" | "wrapper";
  chapter?: ChapterRef;
  runningHead?: Partial<RunningHeadText> | false;
  /** Default true untuk interior, false untuk wrapper. */
  register?: boolean;
  /** true (default) = isi dibungkus `.body` (grid kolom + rel); false = isi diletakkan apa adanya (mis. `.cvr`, `.wbody`). */
  grid?: boolean;
  /** Atribut tambahan pada `.page`, mis. `{ "data-address": "sec:S01" }`. Nilai di-escape. */
  attrs?: Readonly<Record<string, string>>;
}

function attrString(attrs: Readonly<Record<string, string>> | undefined): string {
  if (!attrs) return "";
  return Object.keys(attrs)
    .filter((k) => /^(data-[a-z0-9-]+|id|aria-label|lang)$/.test(k))
    .sort()
    .map((k) => ` ${k}="${esc(attrs[k])}"`)
    .join("");
}

/** Satu lembar `.page` (mode berhalaman, konvensi S25 D-38). */
export function pageSheet(i: PageSheetInput): string {
  const wrapper = i.kind === "wrapper";
  const head =
    i.runningHead === false || (wrapper && i.runningHead === undefined)
      ? ""
      : runningHeadHtml(runningHeadText(i.tpl, i.meta, i.chapter, i.runningHead || undefined));
  const body = i.grid === false ? i.bodyHtml : `<div class="body">${i.bodyHtml}</div>`;
  const reg = (i.register ?? !wrapper) ? registerHtml(i.tpl, i.meta) : "";
  return `<section class="page${wrapper ? " wrap" : ""}"${attrString(i.attrs)}>${head}${body}${reg}</section>`;
}
