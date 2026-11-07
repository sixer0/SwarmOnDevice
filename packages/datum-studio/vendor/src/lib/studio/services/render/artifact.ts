/**
 * Swarm TWIN (row 31c; decisions C60/C65; store spec M07 DROP, 01_specs_studio.md §1.2 site 1) of the
 * clone's standalone-artifact render pipeline (S51, I41 `renderArtifact`).
 *
 * The DATUM Studio store has no `StudioArtifact` table: standalone artifacts (chart, diagram, image,
 * HTML artifact rows of R09) are not part of DATUM Studio for Swarm. Figures are rendered from the
 * inline specs of document blocks (`figures.ts`, row 109) and previewed by the figure-preview route.
 * The same refusal is already made by `job.ts` (`createRenderJob` without a revision) and by
 * `figures.ts` (`ArtifactSpecReader`): an artifact id is unknown -> 404 `ARTIFACT_NOT_FOUND`, before any
 * job, file or row is made.
 *
 * Kept: the export `renderArtifactImpl` with its signature (index.ts `renderArtifact`). Not kept (no
 * caller in Swarm, all need artifact rows): the HTML-artifact gate `gateHtmlArtifact` and its types,
 * the per-kind format table, the artifact job, image loading and HTML-artifact assembly. Clone sha256
 * and the reason are recorded in vendor/provenance.json.
 */
import type { RenderOutcome, StudioCaller, StudioOutputFormat } from "../../contract";
import { StudioEngineError } from "../../contract/errors";

export async function renderArtifactImpl(
  artifactId: string,
  _formats: readonly StudioOutputFormat[],
  _caller: StudioCaller,
): Promise<RenderOutcome> {
  throw new StudioEngineError("ARTIFACT_NOT_FOUND", `artifact ${artifactId} not found`, { artifactId });
}
