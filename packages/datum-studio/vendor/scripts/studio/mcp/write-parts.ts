/**
 * IMPL-W3 siklus perbaikan 1 (D-539): penulis terakhir PER BAGIAN (W3-L4, S2-2, L-5). Sebelum tulis ulang utuh
 * (`studio_write`) mengirim bagian (bab/slot) yang isinya berbeda dari server, penulis terakhir bagian itu (R15: slot
 * `lastFilledBy`, bab `present[].by`) harus pemanggil; selain itu PART_CHANGED_BY_OTHER (hasil normal, 0 tulis) yang
 * menyebut bagian itu. Tulisan pihak lain yang lebih lama dari tulisan terakhir pemanggil tidak lagi tertimpa diam-diam.
 * Pagar server (`baseRevisionNo` -> 409 lingkup) tetap wasit untuk tulisan sesudah pembacaan ini.
 */
import { studioRoutePath } from "../../../src/lib/studio/contract/env";
import { McpToolError } from "./safety";
import { http, isRecord, type ToolContext } from "./tool-kit";

/** W4-L1: revisi terakhir per bagian di R15 (slot `lastFilledRevisionNo`, bab `present[].revisionNo`), atau null. */
export const partRevs = new WeakMap<Map<string, string | null>, Map<string, number | null>>();

/** Penulis terakhir per bagian: kunci `record`/`slot <key>`/`bab <key>` -> penulis (`agent:<id>`) atau null. */
export async function partWriters(ctx: ToolContext, documentId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const revs = new Map<string, number | null>();
  partRevs.set(out, revs);
  const reply = await http(ctx, "GET", studioRoutePath("R15", { id: documentId }), "GET /api/studio/documents/{id}/completeness");
  const comp = isRecord(reply.body) && isRecord(reply.body.completeness) ? reply.body.completeness : {};
  for (const s of Array.isArray(comp.slots) ? comp.slots.filter(isRecord) : []) {
    const by = typeof s.lastFilledBy === "string" ? s.lastFilledBy : null;
    out.set(String(s.slotKey), by);
    out.set(`slot ${String(s.slotKey)}`, by);
    const rev = typeof s.lastFilledRevisionNo === "number" ? s.lastFilledRevisionNo : null;
    revs.set(String(s.slotKey), rev);
    revs.set(`slot ${String(s.slotKey)}`, rev);
  }
  for (const c of isRecord(comp.chapters) ? Object.values(comp.chapters).filter(isRecord) : []) {
    for (const p of Array.isArray(c.present) ? c.present.filter(isRecord) : []) {
      out.set(`bab ${String(p.key)}`, typeof p.by === "string" ? p.by : null);
      revs.set(`bab ${String(p.key)}`, typeof p.revisionNo === "number" ? p.revisionNo : null);
    }
  }
  return out;
}

/**
 * Tolak bila salah satu bagian yang akan ditulis terakhir ditulis pihak lain. IMPL-W4 S2-2r (review 13): bagian yang
 * SUDAH ADA di server (`present`) dengan penulis tidak diketahui (null/tidak tercatat di R15) juga ditolak, kecuali sesi
 * MCP ini sendiri yang menulisnya (`session.noteParts`). Bagian baru (belum ada di server) tidak menimpa apa pun.
 */
export async function requireOwnParts(ctx: ToolContext, documentId: string, parts: readonly string[], me: string, present: (part: string) => boolean = () => true): Promise<void> {
  if (parts.length === 0) return;
  const writers = await partWriters(ctx, documentId);
  const others = parts.filter((p) => {
    const by = writers.get(p);
    if (typeof by === "string") return by !== me;
    if (!present(p)) return false;
    // W4-L1: diizinkan hanya bila sesi ini menulis bagian itu DAN revisi terakhir bagian di R15 tidak lebih baru dari
    // revisi tulisan sesi (pihak lain yang menulis sesudahnya, atau revisi tidak diketahui, -> ditolak).
    const mine = ctx.session.wrotePart(documentId, p);
    const last = partRevs.get(writers)?.get(p) ?? null;
    return mine === null || last === null || last > mine;
  });
  if (others.length > 0) {
    throw new McpToolError(
      "PART_CHANGED_BY_OTHER",
      `${others.length} bagian yang akan ditulis ulang terakhir ditulis pemanggil lain atau penulisnya tidak tercatat (${others.length <= 6 ? others.join(", ").replace(/[^A-Za-z0-9 ,:-]/g, "") : `${others.length} bagian`}); tulis ulang utuh akan menimpanya, jadi tidak ada yang dikirim. Ubah bagian itu dengan studio_edit (membaca revisi terkini), atau tulis tanpa bagian itu. Penulis ada di blok rincian`,
      { untrusted: true, details: { documentId, parts: others, writers: others.map((p) => ({ part: p, by: writers.get(p) ?? null })) } },
    );
  }
}
