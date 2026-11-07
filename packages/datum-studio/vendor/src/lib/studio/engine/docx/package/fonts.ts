/**
 * Wadah fon tertanam (S14 sisi paket; antarmuka ke S15 `engine/docx/fonts`).
 *
 * S15 menyusun `EmbeddedFontPlan` (wajah, slot, GUID, partName, relId) dan
 * menyediakan `obfuscateFont`. Paket ini menulis: `word/fontTable.xml`
 * (`w:embed*` + `w:fontKey`), `word/_rels/fontTable.xml.rels`, bagian
 * `word/fonts/fontN.odttf`, dan Default tipe isi `odttf` (research/07 §9.4:
 * 18 berkas, slot Bold = wajah SemiBold).
 *
 * Byte odttf: bila pemanggil sudah menaruh `partName` di `DocxPackageInput.parts`
 * (hasil obfuscateFont S20/S15), byte itu dipakai apa adanya; bila tidak,
 * berkas `absPath` dibaca lalu diobfuskasi lewat `obfuscateFont` S15.
 */
import { existsSync, readFileSync } from "node:fs";

import type { EmbeddedFontPlan } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { obfuscateFont } from "../fonts";
import { REL, type FontTableEmbed, type Relationship } from "./parts";

const GUID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const PART_RE = /^word\/fonts\/[A-Za-z0-9_.-]+\.odttf$/;

export interface FontContainer {
  embeds: FontTableEmbed[];
  /** Relasi `word/_rels/fontTable.xml.rels` (kosong bila tanpa fon). */
  relationships: Relationship[];
  parts: Array<{ path: string; data: Uint8Array }>;
}

export function buildFontContainer(
  plan: EmbeddedFontPlan | undefined,
  provided: ReadonlyMap<string, Uint8Array>,
): FontContainer {
  const out: FontContainer = { embeds: [], relationships: [], parts: [] };
  if (!plan || plan.fonts.length === 0) return out;
  const seenRel = new Set<string>();
  const seenPart = new Set<string>();
  const seenSlot = new Set<string>();
  for (const f of plan.fonts) {
    if (!GUID_RE.test(f.guid)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `GUID fon tidak sah untuk ${f.face}/${f.slot}: ${f.guid}`);
    }
    if (!PART_RE.test(f.partName)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `partName fon harus word/fonts/*.odttf: ${f.partName}`);
    }
    const slotKey = `${f.face}|${f.slot}`;
    if (seenRel.has(f.relId) || seenPart.has(f.partName) || seenSlot.has(slotKey)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Rencana fon ganda: ${slotKey} ${f.relId} ${f.partName}`);
    }
    seenRel.add(f.relId);
    seenPart.add(f.partName);
    seenSlot.add(slotKey);

    let data = provided.get(f.partName);
    if (!data) {
      if (!existsSync(f.absPath)) {
        throw new StudioEngineError("FILE_MISSING_ON_DISK", `Berkas fon tidak ada: ${f.absPath}`, { face: f.face, slot: f.slot });
      }
      data = obfuscateFont(new Uint8Array(readFileSync(f.absPath)), f.guid);
    }
    out.embeds.push({ face: f.face, slot: f.slot, relId: f.relId, guid: f.guid });
    out.relationships.push({ id: f.relId, type: REL.font, target: f.partName.slice("word/".length) });
    out.parts.push({ path: f.partName, data });
  }
  return out;
}
