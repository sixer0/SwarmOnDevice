/**
 * Cek by-construction intrinsik ingest (S48) dan pengikatan register (bind).
 *
 * Hanya cek yang melekat pada bentuk dokumen dan dibutuhkan normalisasi /
 * renderer; cek lint lain milik engine/lint (S44-S47) dan dipanggil gerbang
 * (gate.ts). ID cek dari registri lint (S10):
 *  - G1       baris tabel: jumlah `gridSpan` sel = `columns.length` (§3.4).
 *  - DATUM-10 tabel ber-caption tanpa `source` (§3.4, by-construction 422).
 *  - DATUM-11 kunci register yang dirujuk turunan tidak terdaftar / entri
 *             register cacat (angka beban keputusan tanpa tanda/asal).
 *  - D03      turunan dihitung ulang terhadap register (bukan penahan ingest;
 *             FAIL hanya SERAH, selain itu REPORT).
 *
 * FIX-1 (S85 R-03, F-053): `renderFeasibilityBlockers` memajukan prasyarat
 * renderer DOCX/HTML turunan ke gerbang ingest dan PATCH. Renderer SELALU
 * menolak (`BY_CONSTRUCTION_FAILED`) turunan yang tidak dapat dibangun
 * (`buildDerivationBlock` -> BindDefect, kunci register tak terdaftar, tanpa
 * id/penomoran, tanpa judul/penutup) kecuali reproduksi verbatim sah
 * (`isVerbatimReproduction`, predikat yang SAMA dengan renderer). Penahan ini
 * bersifat integritas: tidak dapat dilepas override maupun D-34, karena
 * render tetap akan gagal apa pun penegakannya.
 */
import type {
  DerivationBlock,
  LintIssue,
  NormDocSnapshot,
  RegisterEntry,
  StudioTier,
  TableBlock,
  ValidationIssue,
} from "../../contract";
import { TABLE_BLOCK_TYPES } from "../../contract";
import { BindDefect, Register, buildDerivationBlock, isVerbatimReproduction, normalizeRegisterEntry, numberLanguageOf } from "../../engine/bind";
import { derivationId } from "../../engine/docx/figures";
import { isObject, joinPointer } from "./util";

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);

function g1Table(t: TableBlock, ptr: string, address: string | undefined, out: LintIssue[]): void {
  const cols = Array.isArray(t.columns) ? t.columns.length : 0;
  (Array.isArray(t.rows) ? t.rows : []).forEach((row, r) => {
    const cells = Array.isArray(row?.cells) ? row.cells : [];
    const span = cells.reduce((n, c) => n + (isObject(c) && typeof c.gridSpan === "number" ? c.gridSpan : 1), 0);
    if (span !== cols) {
      out.push({
        checkId: "G1",
        status: "FAIL",
        detail: `Baris ${r + 1}: ${span} kolom grid (gridSpan dihitung) tidak sama dengan ${cols} kolom tabel`,
        address,
        pointer: joinPointer(ptr, "rows", r),
      });
    }
    cells.forEach((c, k) => {
      if (isObject(c) && isObject(c.nested)) g1Table(c.nested as unknown as TableBlock, joinPointer(ptr, "rows", r, "cells", k, "nested"), address, out);
    });
  });
}

/** Kumpulkan semua TableBlock di dalam konten (termasuk tabel di halaman depan dan header/footer). */
function forEachTable(node: unknown, ptr: string, fn: (t: TableBlock, ptr: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => forEachTable(n, joinPointer(ptr, i), fn));
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.type === "string" && TABLE_TYPES.has(node.type) && Array.isArray(node.rows) && Array.isArray(node.columns)) {
    fn(node as unknown as TableBlock, ptr);
    return; // tabel bersarang ditangani g1Table
  }
  for (const [k, v] of Object.entries(node)) {
    if (k !== "x" && v !== null && typeof v === "object") forEachTable(v, joinPointer(ptr, k), fn);
  }
}

/**
 * G1 dan DATUM-10 atas semua blok snapshot. `pointers` = blockId -> pointer
 * badan permintaan (dari normalisasi).
 */
export function tableChecks(snapshot: NormDocSnapshot, pointers: ReadonlyMap<string, string>): LintIssue[] {
  const out: LintIssue[] = [];
  for (const b of snapshot.blocks) {
    const ptr = pointers.get(b.blockId) ?? "";
    const address = b.artifactLabel ?? b.address ?? undefined;
    forEachTable(b.content, ptr, (t, tPtr) => {
      g1Table(t, tPtr, address, out);
      if (isObject(t.caption) && !isObject(t.source)) {
        out.push({ checkId: "DATUM-10", status: "FAIL", detail: "Tabel ber-caption tanpa baris SUMBER (source)", address, pointer: tPtr });
      }
    });
  }
  return out;
}

export interface BindResult {
  /** Register ternormalisasi (entri cacat dibuang). */
  register: Record<string, RegisterEntry>;
  issues: LintIssue[];
}

function derivationKeys(d: DerivationBlock): string[] {
  const keys: string[] = [];
  for (const ln of Array.isArray(d.lines) ? d.lines : []) {
    const v: unknown = ln?.value;
    if (isObject(v) && typeof v.registerKey === "string") keys.push(v.registerKey);
  }
  if (isObject(d.result) && typeof d.result.registerKey === "string") keys.push(d.result.registerKey);
  if (isObject(d.verdict) && typeof d.verdict.registerKey === "string") keys.push(d.verdict.registerKey);
  return keys;
}

/**
 * Pengikatan register (port datumbind, S12): normalisasi setiap entri
 * (`normalizeRegisterEntry`), lalu setiap blok `derivation` diperiksa: kunci
 * tak terdaftar -> DATUM-11 FAIL (penahan ingest); aritmetika/kelengkapan
 * (`buildDerivationBlock`) -> D03 (FAIL di SERAH, REPORT selain itu).
 */
export function bindRegister(
  snapshot: NormDocSnapshot,
  pointers: ReadonlyMap<string, string>,
  tier: StudioTier,
  registerPointer: string,
): BindResult {
  const issues: LintIssue[] = [];
  const register: Record<string, RegisterEntry> = {};
  for (const [key, raw] of Object.entries(snapshot.register ?? {})) {
    try {
      register[key] = normalizeRegisterEntry(key, raw);
    } catch (e) {
      issues.push({
        checkId: "DATUM-11",
        status: "FAIL",
        detail: e instanceof Error ? e.message : String(e),
        pointer: joinPointer(registerPointer, key),
      });
    }
  }
  const reg = new Register(register, numberLanguageOf(snapshot.doc.meta?.language));
  for (const b of snapshot.blocks) {
    if (b.type !== "derivation" || !isObject(b.content)) continue;
    const d = b.content as unknown as DerivationBlock;
    const ptr = pointers.get(b.blockId) ?? "";
    const address = b.artifactLabel ?? b.address ?? undefined;
    const missing = [...new Set(derivationKeys(d).filter((k) => !reg.has(k)))];
    if (missing.length > 0) {
      issues.push({
        checkId: "DATUM-11",
        status: "FAIL",
        detail: `Turunan merujuk kunci register yang tidak terdaftar: ${missing.join(", ")}`,
        address,
        pointer: ptr,
      });
      continue;
    }
    try {
      const label = b.artifactLabel?.replace(/^Turunan /, "");
      buildDerivationBlock(d, reg, label);
    } catch (e) {
      if (!(e instanceof BindDefect)) throw e;
      issues.push({ checkId: "D03", status: tier === "SERAH" ? "FAIL" : "REPORT", detail: e.message, address, pointer: ptr });
    }
  }
  return { register, issues };
}

/** checkId penahan kelayakan render turunan (ID registri D03, kata kunci `renderFeasibility`). */
export const RENDER_FEASIBILITY_KEYWORD = "renderFeasibility";

/**
 * Penahan kelayakan render turunan (S85 R-03, F-053). `snapshot.register`
 * boleh mentah (dinormalisasi di sini; entri cacat dilewati karena DATUM-11
 * sudah menahannya) atau sudah ternormalisasi. `doc` = dokumen yang dipakai
 * predikat reproduksi verbatim (untuk PATCH oleh pemanggil tidak tepercaya:
 * salinan TANPA penanda benchmark). Kembalian kosong = semua turunan dapat
 * dirender DOCX dan HTML.
 */
export function renderFeasibilityBlockers(
  snapshot: NormDocSnapshot,
  pointers: ReadonlyMap<string, string> = new Map(),
  doc: NormDocSnapshot["doc"] = snapshot.doc,
): ValidationIssue[] {
  const derivations = snapshot.blocks.filter((b) => b.type === "derivation" && isObject(b.content));
  if (derivations.length === 0) return [];
  const register: Record<string, RegisterEntry> = {};
  for (const [key, raw] of Object.entries(snapshot.register ?? {})) {
    try {
      register[key] = normalizeRegisterEntry(key, raw);
    } catch {
      /* DATUM-11 menahan entri cacat di jalur lain */
    }
  }
  const reg = new Register(register, numberLanguageOf(snapshot.doc.meta?.language));
  const out: ValidationIssue[] = [];
  for (const b of derivations) {
    const d = b.content as unknown as DerivationBlock;
    if (isVerbatimReproduction(doc, d)) continue;
    const address = b.artifactLabel ?? b.address ?? b.blockId;
    const push = (why: string): void => {
      out.push({
        pointer: pointers.get(b.blockId) ?? "",
        keyword: RENDER_FEASIBILITY_KEYWORD,
        message: `D03 @ ${address}: turunan tidak dapat dirender (${why}); renderer DOCX/HTML akan menolak dengan BY_CONSTRUCTION_FAILED`,
        checkId: "D03",
      });
    };
    if (!Array.isArray(d.lines) || !d.title || !d.closing) {
      push("bentuk turunan tidak lengkap: lines/title/closing wajib");
      continue;
    }
    const id = derivationId(b, d, snapshot.numbering ?? {});
    if (!id) {
      push("tanpa id (D-C.n) dan tanpa penomoran");
      continue;
    }
    const missing = [...new Set(derivationKeys(d).filter((k) => !reg.has(k)))];
    if (missing.length > 0) {
      push(`kunci register tidak terdaftar: ${missing.join(", ")}`);
      continue;
    }
    try {
      buildDerivationBlock(d, reg, id);
    } catch (e) {
      push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
