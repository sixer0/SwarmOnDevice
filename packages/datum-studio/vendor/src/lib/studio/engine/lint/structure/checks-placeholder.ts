/**
 * Swarm 1.3.3 row 52 (ST-5; register 03 s2 and s7): `PLACEHOLDER_UNFILLED`, the document-level twin of the build
 * refusal in `engine/diagram/core/spec.ts`. Both read with the same scanner (`unfilledPlaceholders`), so preview
 * (build), document lint (this check) and render (build + this check) name the same id, field and token.
 *
 * Two scopes, one id:
 *  1. Diagram specs (row 52): the inline spec of every `diagram` block. FAIL at every tier (the figure build refuses
 *     the spec at every tier too). A block that refers to an artefact carries no spec in the snapshot; its spec is
 *     read at render, where the build refuses it.
 *  2. Document text (row 137, decision C19): every string that the document prints outside a diagram spec: prose
 *     (paragraph text and inline runs), headings (chapter, section and part titles), table cells, captions, sources,
 *     key rows, front matter (`meta`, cover, control sheet, signature, toc), inline chart specs, and the blocks that
 *     only the v2 snapshot holds (`slotPlaceholder` of a draft, source register entries, contract records).
 *     Tier rule (the form of LD-02 `CONTENT_CHAPTER_GAP`, registry tiers "all", status set by the check): FAIL at
 *     TERBIT and SERAH (release FAIL), REPORT at NOTA (the draft tier: a warning, release not failed).
 *
 * Not read (never printed, or read elsewhere): property names, `x` (metadata), `assets`, `mission`, `register`,
 * `$schema`, `template`, ids, pids, keys and hashes, and the diagram spec (scope 1 reads it).
 *
 * Template slots are keyed sections (`studio.slot/v2`, R13 / `studio_slot_fill`): compose writes the slot's value into
 * the document before lint runs, so a filled slot never reaches this check; a slot whose value (or draft placeholder
 * text, `slot.placeholderText`) is a token prints it and is caught like any other text.
 */
import type { StudioTier } from "../../../contract";
import { isNormSnapshotV2 } from "../../../contract";
import { unfilledPlaceholders } from "../../diagram/core/spec";
import { findings, type CheckOutcome, type Finding, type StructCtx } from "./context";

const PLACEHOLDER_UNFILLED_ID = "PLACEHOLDER_UNFILLED";

/** Keys whose values are never printed (metadata, identity, hashes) or are read by another scope. */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  "x",
  "assets",
  "mission",
  "register",
  "$schema",
  "template",
  "blockId",
  "pid",
  "id",
  "key",
  "slotKey",
  "unitKey",
  "contentSha256",
  "assetSha256",
  "artifactId",
]);
/** Front units whose v2 snapshot block repeats `doc.front` (read there, not twice). */
const FRONT_UNIT_TYPES: ReadonlySet<string> = new Set(["cover", "controlSheet", "signatureBlock", "signature", "toc"]);
/** A document is deeper than a spec: chapters/sections/blocks/rows/cells/paragraphs/runs and nested tables. */
const TEXT_DEPTH_MAX = 64;

/** Text tier rule: FAIL at TERBIT/SERAH, REPORT at NOTA (draft). */
function placeholderTextStatus(tier: StudioTier): "FAIL" | "REPORT" {
  return tier === "NOTA" ? "REPORT" : "FAIL";
}

const esc = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");

/** Every printed string of `root` with its pointer (relative to `base`); the diagram spec of a block is skipped. */
function printedStrings(root: unknown, base: string, seenIds?: Set<string>): Array<{ pointer: string; text: string }> {
  const out: Array<{ pointer: string; text: string }> = [];
  const walk = (v: unknown, pointer: string, depth: number): void => {
    if (typeof v === "string") {
      if (v.includes("{{")) out.push({ pointer, text: v });
      return;
    }
    if (depth >= TEXT_DEPTH_MAX || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${pointer}/${i}`, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    if (seenIds && typeof o.blockId === "string") seenIds.add(o.blockId);
    const isDiagram = o.type === "diagram";
    for (const k of Object.keys(o)) {
      if (SKIP_KEYS.has(k)) continue;
      if (k === "spec" && isDiagram) continue;
      walk(o[k], `${pointer}/${esc(k)}`, depth + 1);
    }
  };
  walk(root, base, 0);
  return out;
}

/** What the reader sees at this pointer, for the detail. */
function kindOf(pointer: string): string {
  if (pointer.startsWith("/meta/") || pointer.startsWith("/front/")) return "halaman depan";
  if (/\/caption(\/|$)/.test(pointer)) return "caption";
  if (/\/source(s)?(\/|$)/.test(pointer)) return "sumber";
  if (/\/keyRow(\/|$)/.test(pointer)) return "baris kunci";
  if (/\/(rows|cells)\//.test(pointer)) return "sel tabel";
  if (/\/(chapters|appendices|parts)\/\d+\/title(\/|$)/.test(pointer) || /\/sections\/\d+\/title(\/|$)/.test(pointer)) return "judul";
  return "teks";
}

/** Label of the nearest block (artefact label, address) or the unit, for the detail. */
function whereOf(ctx: StructCtx, pointer: string): string {
  let best: { len: number; label: string } | undefined;
  for (const it of ctx.walk.items) {
    if ((pointer === it.pointer || pointer.startsWith(`${it.pointer}/`)) && (!best || it.pointer.length > best.len)) {
      best = { len: it.pointer.length, label: it.artifactLabel ?? it.address ?? it.pointer };
    }
  }
  if (best) return best.label;
  for (const u of ctx.walk.units) if (pointer.startsWith(`${u.pointer}/`)) return `${u.zone === "appendix" ? "Lampiran" : "Bab"} ${u.key}`;
  return pointer.split("/").slice(0, 3).join("/");
}

/** Scope 2: one finding per token in printed document text. */
function textFindings(ctx: StructCtx): Finding[] {
  const status = placeholderTextStatus(ctx.tier);
  const tail = status === "REPORT" ? "; NOTA: dilaporkan saja, ditolak di TERBIT/SERAH" : "";
  const found: Finding[] = [];
  const report = (pointer: string, text: string, where: string, kind: string, address?: string): void => {
    for (const u of unfilledPlaceholders({ s: text })) {
      found.push({
        status,
        ...(address ? { address } : { pointer }),
        detail: `${where}: penanda ${u.token} belum terisi di ${kind} (${pointer}) dan akan tercetak apa adanya; ganti dengan nilainya (kurung ganda yang memang teks ditulis berjarak: { {kunci} })${tail}`,
      });
    }
  };
  const seen = new Set<string>();
  for (const s of printedStrings(ctx.doc, "", seen)) report(s.pointer, s.text, whereOf(ctx, s.pointer), kindOf(s.pointer));
  // Blocks only the v2 snapshot holds (draft slot placeholders, source register entries, contract records).
  if (isNormSnapshotV2(ctx.snap)) {
    for (const b of ctx.snap.blocks ?? []) {
      if (seen.has(b.blockId) || FRONT_UNIT_TYPES.has(b.type)) continue;
      const where = b.address ?? b.unitKey ?? `blok ${b.blockId}`;
      const kind = b.type === "slotPlaceholder" ? "teks pengganti slot kosong" : `blok ${b.type}`;
      for (const s of printedStrings(b.content, `/blocks/${b.blockId}/content`)) report(s.pointer, s.text, where, kind, b.address ?? b.unitKey ?? undefined);
    }
  }
  return found;
}

/** Scope 1 (row 52): one FAIL per token in a diagram spec; pointer into `snapshot.doc` (block pointer + `/spec` + field). */
function specFindings(ctx: StructCtx): { diagrams: number; found: Finding[] } {
  const diagrams = ctx.walk.items.filter((it) => it.block.type === "diagram");
  const found: Finding[] = diagrams.flatMap((it) =>
    unfilledPlaceholders(it.block.spec).map((u) => ({
      pointer: `${it.pointer}/spec${u.pointer}`,
      detail: `${it.artifactLabel ?? it.address ?? it.pointer}: penanda ${u.token} belum terisi di spec${u.pointer}; ganti dengan nilainya (kurung ganda yang memang teks ditulis berjarak: { {kunci} })`,
    })),
  );
  return { diagrams: diagrams.length, found };
}

function placeholderUnfilled(ctx: StructCtx): CheckOutcome {
  const spec = specFindings(ctx);
  return findings([...spec.found, ...textFindings(ctx)], `${spec.diagrams} diagram tanpa penanda {{kunci}} yang belum terisi`);
}

export const STRUCTURE_PLACEHOLDER_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  [PLACEHOLDER_UNFILLED_ID]: placeholderUnfilled,
};
