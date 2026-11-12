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
  return [...diagramColourSources(spec, sheet).keys()].sort();
}

/**
 * Swarm 1.2.6 row 62 (T-06, register E-10): the same token model as `diagramColourValues`, keyed by
 * hex value, with the spec sources that print each value (`edge.kind <kind>`, `mark <MARK>`,
 * `class.accent`, `simbol <id>`, ...). Insertion order of the sources follows the emission order.
 * Paper is removed. `diagramColourValues` is the sorted key list of this map.
 */
export function diagramColourSources(spec: StudioDiagramV1, sheet: Sheet): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const addHex = (h: string, src: string): void => {
    const k = h.toUpperCase();
    const list = out.get(k);
    if (!list) out.set(k, [src]);
    else if (!list.includes(src)) list.push(src);
  };
  const add = (token: string, src: string): void => addHex(colourOf(token), src);
  if (sheet.lanes.length > 0) {
    add("ink200", "garis lajur");
    add("ink400", "nama lajur");
  }
  if (sheet.lifelines.length > 0) add("ink200", "garis kehidupan");
  if ((spec.zones ?? []).length > 0) add("ink400", "zona");
  for (const e of spec.edges ?? []) add(EDGE_KINDS[e.kind].colour, `edge.kind ${e.kind}`);
  for (const nd of sheet.nodes.values()) {
    const n = nd.spec;
    add(nodeStrokeToken(nd), "garis simpul");
    const c = n.class ?? {};
    if (c.accent) add("ink400", "arsiran class.accent"); // pola arsiran 45/135
    if (c.secondary) add("ink400", "arsiran class.secondary");
    if ((n.shape ?? "box") === "shadowed") add("ink200", "bayangan shadowed");
    add("ink900", "label simpul");
    if (n.sub) add(role("source_line").colour ?? INK_TEXT, "sub simpul");
    if (n.mark) add(MARK_COLOUR_TOKENS[n.mark] ?? "signal", `mark ${n.mark}`); // row 124 (CP-29): Tabel 7.1
    if (n.tag) add("ink400", "tag simpul");
  }
  const hasLegend = drawsSvgKeyRow(spec); // D-288: KEY SVG hanya bila halaman tidak mencetak KUNCI
  if ((spec.apparatus ?? "page") === "figure") {
    add("ink700", "caption");
    add("ink400", "SUMBER");
  }
  if (hasLegend) add("ink400", "KUNCI");
  // Row 124 (CP-45): colours of the library symbols drawn on nodes (fill/stroke literals of the cell).
  for (const nd of sheet.nodes.values()) {
    const sid = nodeSymbolId(nd.spec);
    if (!sid) continue;
    for (const m of symbolBody(sid).markup.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)) addHex(m[1], `simbol ${sid}`);
  }
  out.delete(PAPER.toUpperCase());
  return out;
}

/**
 * Swarm 1.2.6 row 62 (T-06): the DATUM-25 detail — every counted value with its sources and the
 * remaining allowance, e.g. `dihitung 6: #0F1A24 (edge.kind data, label simpul), ... — sisa −1`.
 * `values` is the authoritative count (the SVG for build, the token model for estimate); a value the
 * source model does not know is labelled `lain di SVG`. A negative remainder uses U+2212.
 */
export function colourCountDetail(values: readonly string[], sources: ReadonlyMap<string, readonly string[]>, limit: number): string {
  const items = values.map((v) => `${v} (${(sources.get(v.toUpperCase()) ?? []).join(", ") || "lain di SVG"})`);
  const rest = limit - values.length;
  return `dihitung ${values.length}: ${items.join(", ")} — sisa ${rest < 0 ? `\u2212${-rest}` : String(rest)}`;
}
