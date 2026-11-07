/**
 * Ekstraksi lapisan teks dari snapshot ternormalisasi untuk pemindai bahasa.
 *
 * Lapisan:
 *  - `prose`: paragraf berperan prosa (`PROSE_ROLES`; tanpa `role` = body) dan
 *    paragraf badan `aside`. Dipakai metrik kalimat (C-26b, C-26c, C-27,
 *    C-31, C-INFO-OPENER) dan plafon kata per paragraf (C-SG-L2-09).
 *  - `narrative`: semua paragraf (peran apa pun), butir daftar, label dan badan
 *    `aside`. Dipakai pemindai sapaan dan rujukan pembaca (C-20, C-34).
 *    Tabel (termasuk `exampleWrongRight` yang sah memuat contoh salah),
 *    `monoBlock`, `derivation`, figur, dan `assumptionInline` tidak dipindai.
 *  - `lists`: blok `list` dengan gaya dan cacah butir (C-SG-L2-04).
 *
 * Teks `text` md-lite (KS-03) dibersihkan dari penanda `*` dan backtick:
 * KS-03 mewajibkan `*`/backtick literal memakai `runs[]`, jadi di `text`
 * keduanya selalu markup. `runs[]`: `t` digabung, `tab` dan `br` menjadi spasi.
 */
import type { NormBlock, NormDocSnapshot } from "../../../contract";

export interface TextUnit {
  blockId: string;
  address?: string;
  /** Peran paragraf atau jenis sumber (`list.item`, `aside.body`, dst.). */
  role: string;
  text: string;
}

export interface ListUnit {
  blockId: string;
  address?: string;
  style: string;
  items: number;
}

export interface Layers {
  prose: TextUnit[];
  narrative: TextUnit[];
  lists: ListUnit[];
}

/** Peran paragraf yang dihitung prosa (judul, kicker, alamat, baris cakupan tidak). */
export const PROSE_ROLES: ReadonlySet<string> = new Set([
  "body",
  "anchor",
  "pivot",
  "closingAction",
  "lede",
  "note",
  "standfirst",
  "methodStatement",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripMdLite(text: string): string {
  return text.replace(/[*`]/gu, "");
}

/** Teks polos dari Inline (`{ text }` md-lite atau `{ runs[] }`). */
export function inlineText(v: unknown): string {
  if (!isRecord(v)) return "";
  if (typeof v.text === "string") return stripMdLite(v.text);
  if (Array.isArray(v.runs)) {
    return v.runs
      .map((r) => {
        if (!isRecord(r)) return "";
        if (typeof r.t === "string") return r.t;
        if (r.tab === true || typeof r.br === "string") return " ";
        return "";
      })
      .join("");
  }
  return "";
}

function unit(b: NormBlock, role: string, text: string): TextUnit {
  return { blockId: b.blockId, ...(b.address ? { address: b.address } : {}), role, text };
}

export function extractLayers(s: NormDocSnapshot): Layers {
  const layers: Layers = { prose: [], narrative: [], lists: [] };
  for (const b of s.blocks) {
    const c = b.content;
    if (!isRecord(c)) continue;
    if (b.type === "paragraph") {
      const role = typeof c.role === "string" ? c.role : "body";
      const text = inlineText(c) || (b.textPlain ?? "");
      const u = unit(b, role, text);
      layers.narrative.push(u);
      if (PROSE_ROLES.has(role)) layers.prose.push(u);
    } else if (b.type === "list") {
      const items = Array.isArray(c.items) ? c.items : [];
      layers.lists.push({
        blockId: b.blockId,
        ...(b.address ? { address: b.address } : {}),
        style: typeof c.style === "string" ? c.style : "bullet",
        items: items.length,
      });
      for (const it of items) layers.narrative.push(unit(b, "list.item", inlineText(it)));
    } else if (b.type === "aside") {
      layers.narrative.push(unit(b, "aside.label", inlineText(c.label)));
      const body = Array.isArray(c.body) ? c.body : [];
      for (const p of body) {
        const u = unit(b, "aside.body", inlineText(p));
        layers.narrative.push(u);
        layers.prose.push(u);
      }
    }
  }
  return layers;
}
