/**
 * Modul engine/lint/language (I37, 01_specs.md §8.2; S47): pemindai bahasa grup C.
 *
 * Kontrak: `lintLanguage(s, params)` mengembalikan LintIssue untuk ke-19 butir
 * C registri (`module: "language"`), setiap butir minimal satu isu:
 *  - 9 butir terimplementasi (D-34): PASS/FAIL (REPORT untuk C-INFO-OPENER),
 *    butir per blok boleh menghasilkan beberapa FAIL beralamat;
 *  - 10 butir ber-`notRunReason` (KT-13, G-07): NOT_RUN dengan alasan registri
 *    yang menyebut alat induk `lint_mutu.py`/`scan_ai_footprint.py`;
 *  - parameter ambang tidak sah, atau galat pemindai: NOT_RUN dengan sebabnya
 *    (tidak pernah PASS palsu, tidak melempar ke runner `engine/lint/scan`).
 * Tier dan gerbang `artifact.lint.enabled` ditangani runner (S44).
 *
 * Tokenisasi: lihat `tokenize.ts`; lapisan teks: lihat `prose.ts`.
 */
import type { LintIssue, NormDocSnapshot, ParamMap } from "../../../contract";
import { isLintImplemented, LINT_REGISTRY } from "../../../registry/lint";
import { buildContext, ID_ONLY_CHECKS, LANGUAGE_SCANNERS, type ScanContext } from "./checks";
import { ParamError } from "./params";
import { extractLayers } from "./prose";

export { LANGUAGE_SCANNERS } from "./checks";
export { countWords, splitSentences } from "./tokenize";

/** Entri registri milik modul ini (19, urutan registri). */
export const LANGUAGE_LINT_DEFS = LINT_REGISTRY.filter((d) => d.module === "language");

function errorDetail(e: unknown): string {
  if (e instanceof ParamError) return `${e.message}; pemeriksaan tidak dijalankan`;
  const msg = e instanceof Error ? e.message : String(e);
  return `galat pemindai engine/lint/language: ${msg}`;
}

/** NOT_RUN jujur dengan notRunReason (KT-13). */
export function lintLanguage(s: NormDocSnapshot, params: ParamMap): LintIssue[] {
  const language = s.doc?.meta?.language === "EN" ? "EN" : "ID";
  let ctx: ScanContext | undefined;
  let ctxError: unknown;
  try {
    ctx = buildContext(extractLayers(s), params, language);
  } catch (e) {
    ctxError = e;
  }

  const out: LintIssue[] = [];
  for (const def of LANGUAGE_LINT_DEFS) {
    if (!isLintImplemented(def)) {
      out.push({ checkId: def.id, status: "NOT_RUN", detail: def.notRunReason });
      continue;
    }
    const scan = LANGUAGE_SCANNERS[def.id];
    if (!scan) {
      out.push({ checkId: def.id, status: "NOT_RUN", detail: "pemindai belum terdaftar di engine/lint/language" });
      continue;
    }
    if (language === "EN" && ID_ONLY_CHECKS.has(def.id)) {
      out.push({ checkId: def.id, status: "NOT_RUN", detail: "meta.language EN; leksikon sapaan SG-L5-08 khusus bahasa Indonesia" });
      continue;
    }
    if (!ctx) {
      out.push({ checkId: def.id, status: "NOT_RUN", detail: errorDetail(ctxError) });
      continue;
    }
    try {
      out.push(...scan(ctx));
    } catch (e) {
      out.push({ checkId: def.id, status: "NOT_RUN", detail: errorDetail(e) });
    }
  }
  return out;
}
