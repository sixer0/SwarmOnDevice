/**
 * Hitung nilai warna DATUM-25 diagram (IP-39b, S84 #2).
 *
 * DEVIASI PARITAS YANG DISENGAJA dari Garis A: Python `build_svg`/`estimate`
 * (`datum_diagram.py`, himpunan `used`) menghitung warna dari model token yang
 * tidak lengkap — label simpul ink900, garis luar `shadowed` ink200, teks label
 * lajur dan tag ink400 tidak terhitung, sedangkan warna peran caption/source/
 * table_header selalu dihitung walau tidak dicetak. Akibatnya gambar dengan
 * 6 nilai warna lulus batas 5 (lulus palsu, mis. `dg_layered_good`).
 *
 * - `svgColourValues(svg)`: SUMBER KEBENARAN build — warna `fill`/`stroke`
 *   (atribut atau deklarasi `style`) pada setiap tag di luar `<defs>`, ditambah
 *   warna isi definisi `<defs>` yang benar-benar dirujuk (`url(#id)`/`href`),
 *   kertas (PAPER) dibuang. Teks isi dan komentar tidak dipindai.
 * - `diagramColourValues(spec, sheet)`: model token yang mencerminkan emisi
 *   `build/svg.ts` + `core/svg.ts` satu per satu, untuk `estimate` (tanpa SVG).
 *   Harus sama dengan `svgColourValues` atas SVG build-nya.
 */
import type { StudioDiagramV1 } from "../../../contract";
import type { Sheet } from "./sheet";
import { drawsSvgKeyRow, nodeStrokeToken, nodeSymbolId } from "./sheet";
import { MARK_COLOUR_TOKENS } from "./svg";
import { symbolBody } from "../../symbols";
import { EDGE_KINDS, INK_TEXT, PAPER, colourOf, role } from "./tokens";

const HEX = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;
const PAINT_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"]);

function normHex(v: string): string | null {
  const t = v.trim();
  if (!HEX.test(t)) return null;
  const h = t.slice(1).toUpperCase();
  return `#${h.length === 3 ? h.replace(/(.)/g, "$1$1") : h}`;
}

/** Warna dan rujukan `#id` dari satu tag pembuka. */
function scanTag(tag: string, colours: Set<string>, refs: Set<string>): void {
  const attr = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  for (let m = attr.exec(tag); m !== null; m = attr.exec(tag)) {
    const name = m[1].toLowerCase();
    const value = m[2];
    if (PAINT_PROPS.has(name)) {
      const c = normHex(value);
      if (c) colours.add(c);
    } else if (name === "style") {
      for (const decl of value.split(";")) {
        const i = decl.indexOf(":");
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim().toLowerCase();
        const val = decl.slice(i + 1);
        if (PAINT_PROPS.has(prop)) {
          const c = normHex(val);
          if (c) colours.add(c);
        }
        for (const u of val.matchAll(/url\(\s*#([^)\s]+)\s*\)/g)) refs.add(u[1]);
      }
    }
    if (name === "href" || name === "xlink:href") {
      if (value.startsWith("#")) refs.add(value.slice(1));
    } else {
      for (const u of value.matchAll(/url\(\s*#([^)\s]+)\s*\)/g)) refs.add(u[1]);
    }
  }
}

/** Semua tag (tanpa komentar/deklarasi) dari potongan SVG. */
function tagsOf(svg: string): string[] {
  const noComments = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  return noComments.match(/<[A-Za-z][^>]*>/g) ?? [];
}

/**
 * Nilai warna yang benar-benar tercetak pada SVG (DATUM-25), terurut,
 * kertas dibuang. Definisi `<defs>` hanya dihitung bila dirujuk dari luar
 * `<defs>` (langsung atau berantai lewat definisi lain).
 */
export function svgColourValues(svg: string): string[] {
  const defsById = new Map<string, { colours: Set<string>; refs: Set<string> }>();
  let outside = svg;
  for (const block of svg.matchAll(/<defs\b[^>]*>([\s\S]*?)<\/defs>/g)) {
    outside = outside.replace(block[0], "");
    const body = block[1];
    const def = /<([A-Za-z][-A-Za-z0-9]*)\b([^>]*?)\bid="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>|<([A-Za-z][-A-Za-z0-9]*)\b([^>]*?)\bid="([^"]+)"([^>]*)\/>/g;
    for (const d of body.matchAll(def)) {
      const id = d[3] ?? d[8];
      const colours = new Set<string>();
      const refs = new Set<string>();
      for (const tag of tagsOf(d[0])) scanTag(tag, colours, refs);
      refs.delete(id);
      defsById.set(id, { colours, refs });
    }
  }
  const colours = new Set<string>();
  const pending: string[] = [];
  for (const tag of tagsOf(outside)) {
    const refs = new Set<string>();
    scanTag(tag, colours, refs);
    pending.push(...refs);
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const d = defsById.get(id);
    if (!d) continue;
    for (const c of d.colours) colours.add(c);
    pending.push(...d.refs);
  }
  // Swarm patch (row 124, CP-43 / C23 check 25 / C29; DT-06 ID p.48): Rev A counts every colour
  // value printed into the figure file, so a definition that nothing references counts too (the
  // original skipped it and passed 4 while the file held 6). The build now defines only what it
  // uses (`diagramDefs(use)`), so for engine output both counts are equal.
  for (const d of defsById.values()) for (const c of d.colours) colours.add(c);
  colours.delete(PAPER.toUpperCase());
  return [...colours].sort();
}

/**
 * Model token warna yang dicetak build (untuk `estimate`, tanpa SVG). Satu
 * baris per emisi di `build/svg.ts` dan `core/svg.ts` (urutan sama):
 * lajur (garis ink200 + nama ink400), garis kehidupan ink200, zona ink400,
 * konektor (jalur, kepala panah, lompatan, label = warna jenis), simpul (garis
 * `nodeStrokeToken`, arsiran ink400, bayangan `shadowed` ink200, label ink900,
 * sub = warna peran source_line, glif asal signal, tag ink400), kaki apparatus
 * (figure: caption ink700 + SUMBER ink400; KUNCI ink400 bila ada legenda).
 */
export function diagramColourValues(spec: StudioDiagramV1, sheet: Sheet): string[] {
  const used = new Set<string>();
  if (sheet.lanes.length > 0) {
    used.add("ink200");
    used.add("ink400");
  }
  if (sheet.lifelines.length > 0) used.add("ink200");
  if ((spec.zones ?? []).length > 0) used.add("ink400");
  for (const e of spec.edges ?? []) used.add(EDGE_KINDS[e.kind].colour);
  for (const nd of sheet.nodes.values()) {
    const n = nd.spec;
    used.add(nodeStrokeToken(nd));
    const c = n.class ?? {};
    if (c.accent || c.secondary) used.add("ink400"); // pola arsiran 45/135
    if ((n.shape ?? "box") === "shadowed") used.add("ink200");
    used.add("ink900");
    if (n.sub) used.add(role("source_line").colour ?? INK_TEXT);
    if (n.mark) used.add(MARK_COLOUR_TOKENS[n.mark] ?? "signal"); // row 124 (CP-29): Tabel 7.1
    if (n.tag) used.add("ink400");
  }
  const hasLegend = drawsSvgKeyRow(spec); // D-288: KEY SVG hanya bila halaman tidak mencetak KUNCI
  if ((spec.apparatus ?? "page") === "figure") {
    used.add("ink700");
    used.add("ink400");
  }
  if (hasLegend) used.add("ink400");
  const hex = new Set<string>();
  for (const t of used) hex.add(colourOf(t).toUpperCase());
  // Row 124 (CP-45): colours of the library symbols drawn on nodes (fill/stroke literals of the cell).
  for (const nd of sheet.nodes.values()) {
    const sid = nodeSymbolId(nd.spec);
    if (!sid) continue;
    for (const m of symbolBody(sid).markup.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)) hex.add(m[1].toUpperCase());
  }
  hex.delete(PAPER.toUpperCase());
  return [...hex].sort();
}
