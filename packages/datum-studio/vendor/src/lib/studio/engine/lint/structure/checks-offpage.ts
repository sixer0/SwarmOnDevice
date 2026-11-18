/**
 * Swarm 1.3.3 row 137 (decision C20; register 03 s6, s7): `OFFPAGE_UNPAIRED` in document lint. Row 50's render step
 * (`services/render/offpage-pairs.ts`, called from `services/render/pure/render.ts`) refuses a document whose off-page
 * connectors are not paired; this check reports the same refusals with the same id and message, so document lint
 * shows them before render. One rule, one implementation: the check calls row 50's `checkOffpagePairs` (that module
 * imports contract types only, so a lint module can call it).
 *
 * What lint cannot see, it does not refuse (never a false FAIL):
 *  - A twin whose spec is an artefact reference (no inline spec in the snapshot): the render reads it through the
 *    artefact reader and judges it there; lint reports NOT_RUN for that end, naming the render.
 *  - A chapter or slot draft (a snapshot cut by `applyRenderScope`): a `ref` to a block that has a number but is not
 *    in the snapshot is outside the scope; NOT_RUN as at render (row 50's scope rule). In a whole document every
 *    numbered block is present, so this changes nothing there.
 * Registry tiers "all": the status is FAIL at every tier (an unpaired connector is never printed: the render refuses
 * it at every tier).
 */
import type { NormDocSnapshot } from "../../../contract";
import { OFFPAGE_UNPAIRED, checkOffpagePairs } from "../../../services/render/offpage-pairs";
import { findings, notRun, type CheckOutcome, type Finding, type StructCtx } from "./context";

const OFFPAGE_UNPAIRED_ID = OFFPAGE_UNPAIRED;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Diagram blocks whose spec is an artefact reference (same test as the render step's `inlineSpecOf`). */
function artefactDiagrams(snap: NormDocSnapshot): Set<string> {
  const out = new Set<string>();
  for (const b of snap.blocks ?? []) {
    if (b.type !== "diagram" || !isRecord(b.content)) continue;
    const spec = b.content.spec;
    if (isRecord(spec) && typeof spec.artifactId === "string" && !("$schema" in spec)) out.add(b.blockId);
  }
  return out;
}

function offpageUnpaired(ctx: StructCtx): CheckOutcome {
  const snap = ctx.snap as unknown as NormDocSnapshot;
  if (!Array.isArray(snap?.blocks)) return notRun("snapshot tanpa daftar blok: pasangan penghubung luar-halaman diperiksa saat render");
  const present = new Set(snap.blocks.map((b) => b.blockId));
  const numbering = isRecord(snap.numbering) ? snap.numbering : {};
  const cut = Object.keys(numbering).some((id) => !present.has(id));
  const check = checkOffpagePairs(snap, cut ? { scope: { kind: "CHAPTER", key: "(lingkup)" } } : {});
  const artefacts = artefactDiagrams(snap);
  const unseen = check.refusals.filter((r) => r.cause === "figure-missing" && r.otherBlockId !== undefined && artefacts.has(r.otherBlockId));

  // FAIL per refusal lint can judge (row 50's message and address); else NOT_RUN for what only the render can judge;
  // else PASS with the render step's own detail.
  const fails: Finding[] = check.refusals
    .filter((r) => !unseen.includes(r))
    .map((r) => ({ status: "FAIL" as const, detail: r.message, ...(r.address ? { address: r.address } : {}) }));
  if (fails.length > 0) return findings(fails, "");
  const reasons = [
    ...check.checks.filter((c) => c.status === "NOT_RUN").map((c) => c.detail),
    ...unseen.map((r) => `belum diperiksa: spec blok ${r.otherBlockId} dirujuk dari artefak; pasangan kunci "${r.key ?? ""}" dari ${r.figure} (blok ${r.blockId}) diperiksa saat render`),
  ];
  const pass = check.checks.find((c) => c.status === "PASS")?.detail;
  if (reasons.length > 0) return notRun(`${reasons.join("; ")}${pass ? `; ${pass}` : ""}`);
  return findings([], pass ?? "0 penghubung luar-halaman di dokumen");
}

export const STRUCTURE_OFFPAGE_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  [OFFPAGE_UNPAIRED_ID]: offpageUnpaired,
};
