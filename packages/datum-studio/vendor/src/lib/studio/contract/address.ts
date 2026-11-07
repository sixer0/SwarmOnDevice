/**
 * Tata bahasa alamat blok (01_specs.md §4.1):
 *
 *   address   = front | part | chapHead | secHead | block | item | artifact | artSub | cell
 *   front     = "F:" slotKey [ "/" posint ]               ; delta SR-04 (register §4.6)
 *   slotKey   = lower *31(ALPHA | DIGIT)                   ; C18 SLOT_KEY_PATTERN
 *               (empat kunci lama "cover" | "controlSheet" | "toc" | "signature" tetap sah)
 *   part      = "P:" posint
 *   chapHead  = chap
 *   secHead   = chap "." posint
 *   block     = chap "." nonneg "." posint          ; seksi 0 = intro bab
 *   item      = block "/" posint
 *   artifact  = ("Tabel" | "Gambar") " " chap "." posint | "Turunan D-" chap "." posint [lower]
 *   artSub    = artifact "/" ("caption" | "source" | "key")
 *   cell      = "Tabel " chap "." posint "/" posint "." posint   ; r.c 1-based
 *   chap      = posint | upper
 *
 * Alamat di URL dienkode `encodeURIComponent` (`Tabel%203.1%2F2.3`); fungsi di
 * sini bekerja pada string yang sudah didekode.
 */

export type FrontPageKey = "cover" | "controlSheet" | "toc" | "signature";
/**
 * Kunci slot pada alamat `F:` (delta SR-04): salah satu dari empat kunci lama
 * atau slotKey kerangka apa pun yang sesuai C18 (mis. `references`).
 */
export type FrontSlotKey = FrontPageKey | (string & {});
/** Empat kunci halaman depan v1 (alamat `F:` lama). */
export const FRONT_PAGE_KEYS: readonly FrontPageKey[] = ["cover", "controlSheet", "toc", "signature"];
export function isFrontPageKey(page: string): page is FrontPageKey {
  return (FRONT_PAGE_KEYS as readonly string[]).includes(page);
}
export type ArtifactKindLabel = "Tabel" | "Gambar" | "Turunan";
export type ArtifactSub = "caption" | "source" | "key";

export type ParsedAddress =
  | { kind: "front"; page: FrontSlotKey; n?: number }
  | { kind: "part"; n: number }
  | { kind: "chapter"; chap: string }
  | { kind: "section"; chap: string; section: number }
  | { kind: "block"; chap: string; section: number; para: number }
  | { kind: "item"; chap: string; section: number; para: number; item: number }
  | { kind: "artifact"; artifact: ArtifactKindLabel; chap: string; n: number; suffix?: string }
  | { kind: "artifactSub"; artifact: ArtifactKindLabel; chap: string; n: number; suffix?: string; sub: ArtifactSub }
  | { kind: "cell"; chap: string; n: number; row: number; col: number };

const POS = "[1-9][0-9]*";
const NONNEG = "(?:0|[1-9][0-9]*)";
const CHAP = `(${POS}|[A-Z])`;
/**
 * IMPL-W4 (review 15 F11, D-551): bab label artefak juga boleh label penomoran sumber outline (`^[A-Za-z0-9]{1,8}$`,
 * mis. "Tabel FM.1", "Gambar 6.1"). Hanya bentuk label artefak; alamat posisi tetap memakai kunci bab internal.
 */
const ART_CHAP = `(${POS}|[A-Za-z][A-Za-z0-9]{0,7})`;

// slotKey = C18 SLOT_KEY_PATTERN tanpa jangkar (empat kunci lama ikut cocok).
const RE_FRONT = new RegExp(`^F:([a-z][a-zA-Z0-9]{0,31})(?:/(${POS}))?$`);
const RE_PART = new RegExp(`^P:(${POS})$`);
const RE_CHAPTER = new RegExp(`^${CHAP}$`);
const RE_SECTION = new RegExp(`^${CHAP}\\.(${POS})$`);
const RE_BLOCK = new RegExp(`^${CHAP}\\.(${NONNEG})\\.(${POS})$`);
const RE_ITEM = new RegExp(`^${CHAP}\\.(${NONNEG})\\.(${POS})/(${POS})$`);
const RE_TG = new RegExp(`^(Tabel|Gambar) ${ART_CHAP}\\.(${POS})(?:/(caption|source|key))?$`);
const RE_TURUNAN = new RegExp(`^Turunan D-${ART_CHAP}\\.(${POS})([a-z])?(?:/(caption|source|key))?$`);
const RE_CELL = new RegExp(`^Tabel ${ART_CHAP}\\.(${POS})/(${POS})\\.(${POS})$`);

/** Mengurai alamat; null bila tidak sesuai EBNF (route -> 400 ADDRESS_INVALID). */
export function parseAddress(input: string): ParsedAddress | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 200) return null;
  let m: RegExpExecArray | null;
  if ((m = RE_FRONT.exec(input))) {
    return m[2] ? { kind: "front", page: m[1], n: Number(m[2]) } : { kind: "front", page: m[1] };
  }
  if ((m = RE_PART.exec(input))) return { kind: "part", n: Number(m[1]) };
  if ((m = RE_CHAPTER.exec(input))) return { kind: "chapter", chap: m[1] };
  if ((m = RE_SECTION.exec(input))) return { kind: "section", chap: m[1], section: Number(m[2]) };
  if ((m = RE_BLOCK.exec(input))) return { kind: "block", chap: m[1], section: Number(m[2]), para: Number(m[3]) };
  if ((m = RE_ITEM.exec(input))) {
    return { kind: "item", chap: m[1], section: Number(m[2]), para: Number(m[3]), item: Number(m[4]) };
  }
  if ((m = RE_CELL.exec(input))) return { kind: "cell", chap: m[1], n: Number(m[2]), row: Number(m[3]), col: Number(m[4]) };
  if ((m = RE_TG.exec(input))) {
    const base = { artifact: m[1] as ArtifactKindLabel, chap: m[2], n: Number(m[3]) };
    return m[4] ? { kind: "artifactSub", ...base, sub: m[4] as ArtifactSub } : { kind: "artifact", ...base };
  }
  if ((m = RE_TURUNAN.exec(input))) {
    const base: { artifact: ArtifactKindLabel; chap: string; n: number; suffix?: string } = {
      artifact: "Turunan",
      chap: m[1],
      n: Number(m[2]),
    };
    if (m[3]) base.suffix = m[3];
    return m[4] ? { kind: "artifactSub", ...base, sub: m[4] as ArtifactSub } : { kind: "artifact", ...base };
  }
  return null;
}

function artifactLabel(a: { artifact: ArtifactKindLabel; chap: string; n: number; suffix?: string }): string {
  return a.artifact === "Turunan" ? `Turunan D-${a.chap}.${a.n}${a.suffix ?? ""}` : `${a.artifact} ${a.chap}.${a.n}`;
}

/** Kebalikan parseAddress: formatAddress(parseAddress(s)!) === s. */
export function formatAddress(p: ParsedAddress): string {
  switch (p.kind) {
    case "front":
      return p.n === undefined ? `F:${p.page}` : `F:${p.page}/${p.n}`;
    case "part":
      return `P:${p.n}`;
    case "chapter":
      return p.chap;
    case "section":
      return `${p.chap}.${p.section}`;
    case "block":
      return `${p.chap}.${p.section}.${p.para}`;
    case "item":
      return `${p.chap}.${p.section}.${p.para}/${p.item}`;
    case "artifact":
      return artifactLabel(p);
    case "artifactSub":
      return `${artifactLabel(p)}/${p.sub}`;
    case "cell":
      return `Tabel ${p.chap}.${p.n}/${p.row}.${p.col}`;
  }
}

export function isValidAddress(input: string): boolean {
  return parseAddress(input) !== null;
}

/** Enkode untuk segmen URL `[address]`. */
export function encodeAddress(address: string): string {
  return encodeURIComponent(address);
}
