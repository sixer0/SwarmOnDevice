/**
 * FIG-03b — muat revisi + templat tersemat untuk pratinjau figur (BACA SAJA: dua findUnique + resolusi
 * templat, sama dengan `prepareScopeRender` layanan render; tanpa job, tanpa tulis).
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/figures/preview/_lib/load.ts. The two
 * Prisma reads become store-bridge reads in one read job (`findDocumentById`, `findRevisionByNo`,
 * `findTemplateVersionById`; row 109 cut, no Prisma). Result shape, error codes and messages unchanged.
 */
import { findDocumentById, findRevisionByNo, findTemplateVersionById, readWith } from "../../../store-bridge/index.ts";
import type { AnyNormSnapshot, ResolvedTemplate } from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { asAnySnapshot } from "@/lib/studio/services/render/common";

export interface FigureContext {
  documentId: string;
  revisionNo: number;
  currentRevisionNo: number;
  snapshot: AnyNormSnapshot;
  template: ResolvedTemplate;
}

export async function loadFigureContext(documentId: string, revisionNo: number | undefined): Promise<FigureContext> {
  const doc = await readWith(undefined, (tx) => findDocumentById(tx, documentId));
  if (!doc) throw new StudioEngineError("DOCUMENT_NOT_FOUND", `document ${documentId} not found`, { documentId });
  const no = revisionNo ?? doc.currentRevisionNo;
  const rev = await readWith(undefined, (tx) => {
    const r = findRevisionByNo(tx, doc.id, no);
    const tv = r ? findTemplateVersionById(tx, r.templateVersionId) : null;
    return r && tv ? { revisionNo: r.revisionNo, snapshot: r.snapshot, templateVersion: tv } : null;
  });
  if (!rev) throw new StudioEngineError("REVISION_NOT_FOUND", `revision ${no} of document ${doc.id} not found`, { documentId: doc.id, revisionNo: no });
  const { resolveTemplate } = await import("@/lib/studio/services/templates");
  const template = await resolveTemplate(rev.templateVersion.template.slug, rev.templateVersion.versionNo);
  return { documentId: doc.id, revisionNo: rev.revisionNo, currentRevisionNo: doc.currentRevisionNo, snapshot: asAnySnapshot(rev.snapshot), template };
}
