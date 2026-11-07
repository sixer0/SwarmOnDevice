/**
 * Swarm patch (row 69a, C78): a NEW document on an archived template is refused `TEMPLATE_ARCHIVED`.
 *
 * Templates spec §4 archive row (docs/2026-11-06_swarm_1_2_0_datum_installer/masterplan/01_specs_studio_templates.md:160):
 * "`studio_template_update` and `studio_document_create` on it are refused (`TEMPLATE_ARCHIVED`); existing documents
 * still resolve, render and re-render on their pinned versions". Callers run this check ONLY on the create path
 * (no document pin); submissions to an existing document resolve its pinned version and never come here.
 */
import type { ResolvedTemplate } from "../../contract";
import { findTemplateById, readWith } from "../_swarm-store";
import { ingestLog } from "./log";

export const TEMPLATE_ARCHIVED_CODE = "TEMPLATE_ARCHIVED" as const;

/** The archived template's slug when `tpl` belongs to an archived store row, else `null` (active, or no store row). */
export async function archivedTemplateSlug(tpl: Pick<ResolvedTemplate, "templateId">, correlationId: string): Promise<string | null> {
  try {
    const row = await readWith(undefined, (tx) => findTemplateById(tx, tpl.templateId));
    return row?.archived ? row.slug : null;
  } catch (e) {
    ingestLog({
      level: "error",
      message: "status arsip templat tidak dapat dibaca",
      correlationId,
      code: "TEMPLATE_ARCHIVED_READ_FAILED",
      stack_trace: e instanceof Error ? e.stack : undefined,
      context: { templateId: tpl.templateId },
    });
    throw e;
  }
}

/** Message of the refusal (same wording as the template service's update refusal). */
export function templateArchivedMessage(slug: string): string {
  return `Templat ${slug} diarsipkan; dokumen baru tidak dapat dibuat padanya. Batalkan arsip dulu, atau pakai templat lain`;
}
