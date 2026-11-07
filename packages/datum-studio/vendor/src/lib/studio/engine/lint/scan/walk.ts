/**
 * Penjelajah dokumen untuk lint teks (S44): menurunkan segmen teks beralamat
 * (§4.1) dan daftar blok tabel dari `StudioDocV1`.
 *
 * Padanan `Ctx.body_text`/`heading_paras` datum_lint.py: badan = semua teks
 * prosa dokumen (judul, paragraf, butir, sel tabel, caption, sumber, rel), satu
 * segmen per blok. Urutan = urutan dokumen (Python menaruh sel tabel setelah
 * semua paragraf; urutan tidak memengaruhi hasil kecuali jendela DATUM-17).
 */
import { TABLE_BLOCK_TYPES } from "../../../contract/enums";
import type { Chapter, FlowItem, Inline, NormDocSnapshot, Run, StudioDocV1, TableBlock } from "../../../contract";

export interface TextSegment {
  /** Alamat §4.1 (mis. "3", "3.2", "3.2.4", "F:cover", "P:1"). */
  address: string;
  /** JSON Pointer ke dokumen (`/chapters/2/sections/1/blocks/3`). */
  pointer: string;
  /** true = judul (bab, lampiran, seksi, bagian, paragraf bertingkat). */
  heading: boolean;
  text: string;
  /**
   * Teks bukan prosa penulis (D-263): `apparatus` = medan aparatus sampul yang
   * formatnya ditetapkan mesin/templat (cap terbit/kolofon, string identitas,
   * blok kendali); `wrongExample` = sel kolom "Salah" tabel contoh salah/benar.
   * Hanya hitungan em dash DATUM-03 yang melewatinya; cek lain tetap membaca.
   */
  role?: "apparatus" | "wrongExample";
}

export interface TableRef {
  address: string;
  pointer: string;
  block: TableBlock;
}

export interface DocWalk {
  segments: TextSegment[];
  tables: TableRef[];
}

const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);

/** Kunci yang bukan prosa (format, data figur, ekstensi). */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  "spec",
  "format",
  "runDefaults",
  "x",
  "labelProps",
  "setup",
  "layout",
  "columns",
  "marker",
  "headingFormat",
  "signRowFormat",
  "colsTw",
  "borders",
  "shading",
  "marginsTw",
]);

const HEADING_ROLES: ReadonlySet<string> = new Set(["subheading", "blockHeading", "pageTitle"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function runsText(runs: readonly Run[]): string {
  let s = "";
  for (const r of runs) {
    if ("t" in r && typeof r.t === "string") s += r.t;
    else if ("tab" in r) s += "\t";
    else if ("br" in r) s += "\n";
  }
  return s;
}

export function inlineText(i: Inline | undefined | null): string {
  if (!i) return "";
  if ("runs" in i && Array.isArray(i.runs)) return runsText(i.runs);
  if ("text" in i && typeof i.text === "string") return i.text;
  return "";
}

/** Kumpulkan semua teks Inline (`text` | `runs`) di bawah simpul, melewati kunci non-prosa. */
export function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectText(v, out);
    return;
  }
  if (!isObj(node)) return;
  if (Array.isArray(node.runs)) out.push(runsText(node.runs as Run[]));
  else if (typeof node.text === "string") out.push(node.text);
  for (const [k, v] of Object.entries(node)) {
    if (k === "text" || k === "runs" || SKIP_KEYS.has(k)) continue;
    if (typeof v === "object" && v !== null) collectText(v, out);
  }
}

function blockText(node: unknown): string {
  const out: string[] = [];
  collectText(node, out);
  return out.filter((s) => s.length > 0).join("\n");
}

export function isHeadingParagraph(b: Record<string, unknown>): boolean {
  if (b.type !== "paragraph") return false;
  if (typeof b.role === "string" && HEADING_ROLES.has(b.role)) return true;
  const f = b.format;
  return isObj(f) && f.outlineLvl !== undefined;
}

export function isTableBlock(b: unknown): b is TableBlock {
  return isObj(b) && typeof b.type === "string" && TABLE_TYPES.has(b.type) && Array.isArray(b.rows) && Array.isArray(b.columns);
}

function appendixKey(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `A${i + 1}`;
}

// ── Tabel contoh salah/benar (FIX-L, F-062; D-263) ────────────────────────

const WRONG_HEAD = /^(?:salah|wrong|incorrect)(?![\p{L}\p{N}])/iu;
const RIGHT_HEAD = /^(?:benar|right|correct)(?![\p{L}\p{N}])/iu;

type AnyRow = { kind?: string; cells: Array<Record<string, unknown> & { gridSpan?: number }> };

function rowsOf(t: TableBlock): AnyRow[] {
  return ((t as unknown as { rows?: AnyRow[] }).rows ?? []).filter((r) => isObj(r) && Array.isArray(r.cells));
}

function cellPlain(c: unknown): string {
  return blockText(c).trim();
}

/** Indeks kolom grid (memperhitungkan gridSpan) tiap sel dalam satu baris. */
function gridIndexes(r: AnyRow): number[] {
  let col = 0;
  return r.cells.map((c) => {
    const at = col;
    col += Math.max(1, typeof c.gridSpan === "number" ? c.gridSpan : 1);
    return at;
  });
}

/**
 * Tabel contoh salah/benar: baris kepala memuat kolom berawalan "Salah" DAN
 * kolom berawalan "Benar" (konvensi "Contoh salah dan benar" manual), atau blok
 * berjenis `exampleWrongRight` (S17: ATURAN | SALAH | BENAR).
 */
export function isWrongRightTable(t: TableBlock): boolean {
  if ((t as { type?: string }).type === "exampleWrongRight") return true;
  return rowsOf(t).some((r) => {
    if (r.kind !== "header") return false;
    const heads = r.cells.map(cellPlain);
    return heads.some((h) => WRONG_HEAD.test(h)) && heads.some((h) => RIGHT_HEAD.test(h));
  });
}

/** Kolom grid "Salah" tabel contoh salah/benar (`exampleWrongRight` tanpa kepala bertanda: kolom 2). */
export function wrongColumns(t: TableBlock): Set<number> {
  const out = new Set<number>();
  if (!isWrongRightTable(t)) return out;
  for (const r of rowsOf(t)) {
    if (r.kind !== "header") continue;
    const idx = gridIndexes(r);
    r.cells.forEach((c, i) => {
      if (WRONG_HEAD.test(cellPlain(c))) out.add(idx[i]);
    });
  }
  if (out.size === 0 && (t as { type?: string }).type === "exampleWrongRight") out.add(1);
  return out;
}

/** Pecah tabel menjadi teks badan (sel "Salah" dikosongkan) dan teks sel "Salah" badan. */
function splitWrongCells(t: TableBlock): { main: unknown; wrong: string[] } | undefined {
  const cols = wrongColumns(t);
  if (cols.size === 0) return undefined;
  const wrong: string[] = [];
  const rows = rowsOf(t).map((r) => {
    if (r.kind === "header") return r;
    const idx = gridIndexes(r);
    return {
      ...r,
      cells: r.cells.map((c, i) => {
        if (!cols.has(idx[i])) return c;
        const s = blockText(c);
        if (s.length > 0) wrong.push(s);
        return {};
      }),
    };
  });
  return { main: { ...(t as unknown as Record<string, unknown>), rows }, wrong };
}

/** Medan data sampul yang formatnya aparatus mesin/templat (cap terbit, identitas, blok kendali). */
const APPARATUS_DATA_KEYS: readonly string[] = ["colophon", "identityString", "control"];

/**
 * Jelajahi dokumen. `snapshot` (opsional) menyumbang alamat ternormalisasi
 * lewat `blockId`; tanpa itu alamat dihitung dari posisi (§4.1).
 */
export function walkDocument(doc: StudioDocV1, snapshot?: NormDocSnapshot): DocWalk {
  const segments: TextSegment[] = [];
  const tables: TableRef[] = [];
  const known = new Map<string, string>();
  for (const b of snapshot?.blocks ?? []) {
    if (b.address && b.blockId) known.set(b.blockId, b.address);
  }

  const push = (address: string, pointer: string, heading: boolean, text: string, role?: TextSegment["role"]): void => {
    if (text.length > 0) segments.push({ address, pointer, heading, text, ...(role ? { role } : {}) });
  };

  /** Satu blok = satu segmen; sel "Salah" tabel contoh salah/benar jadi segmen `wrongExample`. */
  const pushBlock = (address: string, pointer: string, item: unknown, heading = isObj(item) && isHeadingParagraph(item)): void => {
    const split = isTableBlock(item) ? splitWrongCells(item) : undefined;
    if (!split) {
      push(address, pointer, heading, blockText(item));
      return;
    }
    push(address, pointer, false, blockText(split.main));
    for (const w of split.wrong) push(address, pointer, false, w, "wrongExample");
  };

  /** Halaman depan: medan aparatus `data.*` menjadi segmen `apparatus` tersendiri. */
  const pushPage = (address: string, pointer: string, page: unknown): void => {
    const data: unknown = isObj(page) ? page.data : undefined;
    if (!isObj(page) || !isObj(data) || !APPARATUS_DATA_KEYS.some((k) => data[k] !== undefined)) {
      push(address, pointer, false, blockText(page));
      return;
    }
    const rest: Record<string, unknown> = { ...data };
    for (const k of APPARATUS_DATA_KEYS) delete rest[k];
    push(address, pointer, false, blockText({ ...page, data: rest }));
    for (const k of APPARATUS_DATA_KEYS) push(address, `${pointer}/data/${k}`, false, blockText(data[k]), "apparatus");
  };

  const flowItem = (item: unknown, address: string, pointer: string): void => {
    if (!isObj(item)) return;
    const id = typeof item.blockId === "string" ? item.blockId : undefined;
    const addr = (id && known.get(id)) || address;
    if (isTableBlock(item)) tables.push({ address: addr, pointer, block: item });
    pushBlock(addr, pointer, item);
  };

  /** Blok isi berurutan; spacer/device tidak menghitung P (§4.1) dan tidak beralamat. */
  const flow = (items: readonly FlowItem[] | readonly unknown[] | undefined, prefix: string, ptr: string): void => {
    let p = 0;
    (items ?? []).forEach((item, i) => {
      const t = isObj(item) ? item.type : undefined;
      if (t === "spacer" || t === "device") {
        if (t === "device") push(prefix, `${ptr}/${i}`, false, blockText(item));
        return;
      }
      p++;
      flowItem(item, `${prefix}.${p}`, `${ptr}/${i}`);
    });
  };

  // Halaman depan (F:cover, F:controlSheet, F:toc, F:signature).
  const front = doc.front;
  if (front) {
    for (const name of ["cover", "controlSheet", "toc", "signature"] as const) {
      const page = front[name];
      if (!page) continue;
      const base = `/front/${name}`;
      const addr = `F:${name}`;
      if (isObj(page) && Array.isArray((page as { body?: unknown[] }).body)) {
        const body = (page as { body: unknown[] }).body;
        let n = 0;
        body.forEach((item, i) => {
          n++;
          const a = `${addr}/${n}`;
          if (isTableBlock(item)) tables.push({ address: a, pointer: `${base}/body/${i}`, block: item });
          pushBlock(a, `${base}/body/${i}`, item);
        });
        const rest = { ...(page as Record<string, unknown>), body: undefined };
        pushPage(addr, base, rest);
      } else {
        pushPage(addr, base, page);
      }
      const pageData: unknown = isObj(page) ? page.data : undefined;
      if (name === "controlSheet" && isObj(pageData)) {
        const data = pageData;
        for (const k of ["revisionHistory", "verificationChain", "distribution"]) {
          if (isTableBlock(data[k])) tables.push({ address: addr, pointer: `${base}/data/${k}`, block: data[k] as TableBlock });
        }
      }
    }
  }

  // Pembatas bagian (P:n).
  (doc.parts ?? []).forEach((part, i) => {
    const addr = `P:${i + 1}`;
    const ptr = `/parts/${i}`;
    push(addr, `${ptr}/title`, true, [inlineText(part.label), inlineText(part.title)].filter(Boolean).join(" "));
    push(addr, `${ptr}/lede`, false, inlineText(part.lede));
    (part.body ?? []).forEach((item, j) => {
      if (isTableBlock(item)) tables.push({ address: addr, pointer: `${ptr}/body/${j}`, block: item });
      pushBlock(addr, `${ptr}/body/${j}`, item, false);
    });
  });

  const chapter = (ch: Chapter, key: string, ptr: string): void => {
    const chId = ch.blockId && known.get(ch.blockId);
    push(chId || key, `${ptr}/title`, true, inlineText(ch.title));
    push(chId || key, `${ptr}/kicker`, false, inlineText(ch.kicker));
    flow(ch.intro, `${key}.0`, `${ptr}/intro`);
    (ch.sections ?? []).forEach((sec, s) => {
      const secAddr = (sec.blockId && known.get(sec.blockId)) || `${key}.${s + 1}`;
      push(secAddr, `${ptr}/sections/${s}/title`, true, inlineText(sec.title));
      flow(sec.blocks, `${key}.${s + 1}`, `${ptr}/sections/${s}/blocks`);
    });
  };

  (doc.chapters ?? []).forEach((ch, i) => chapter(ch, ch.key ?? String(i + 1), `/chapters/${i}`));
  (doc.appendices ?? []).forEach((ch, i) => chapter(ch, ch.key ?? appendixKey(i), `/appendices/${i}`));

  return { segments, tables };
}

/**
 * Nama yang diuji N1 / DATUM-38 (garis bawah): nama media aset (stem berkas)
 * dan nomor dokumen.
 *
 * D-80: folder misi (`mission.folder`, pola IL `YYYY-MM-DD_<misi>`, cadangan
 * `<issueDate>_studio`) dan segmen direktori path penyimpanan/sumber aset
 * adalah path infrastruktur, bukan nama deliverable: TIDAK diuji. Lint
 * penamaan hanya untuk nama berkas deliverable, judul, ID tabel/gambar dan
 * identifier rekayasa (manual 3.5).
 */
export interface NameRef {
  name: string;
  pointer: string;
  kind: "asset" | "docNumber";
}

export function documentNames(doc: StudioDocV1): NameRef[] {
  const out: NameRef[] = [];
  for (const [key, a] of Object.entries(doc.assets ?? {})) {
    if (typeof a?.path !== "string") continue;
    const ptr = `/assets/${key.replace(/~/g, "~0").replace(/\//g, "~1")}/path`;
    const file = a.path.split(/[\\/]+/).filter(Boolean).pop();
    if (!file) continue;
    // Python c38 menguji stem (tanpa ekstensi) nama media internal.
    const dot = file.lastIndexOf(".");
    out.push({ name: dot > 0 ? file.slice(0, dot) : file, pointer: ptr, kind: "asset" });
  }
  if (typeof doc.meta?.docNumber === "string") out.push({ name: doc.meta.docNumber, pointer: "/meta/docNumber", kind: "docNumber" });
  return out;
}
