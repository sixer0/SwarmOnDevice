/**
 * Job render tanpa DB dan pembaca spec tanpa DB (IP-43a, permintaan FIX-5).
 *
 * `buildFigures` (S51) butuh `RenderJobHandle` dan `ArtifactSpecReader`; kedua
 * kelas produksi menyentuh Prisma hanya lewat `persist()`/`read()`. Turunan di
 * sini menimpa tepat dua metode itu sehingga orkestrator murni memakai fungsi
 * layanan apa adanya tanpa pernah menulis atau membaca DB:
 *
 * - `DetachedRenderJob`: `persist()` no-op (status, galat, dan log tetap di
 *   memori; pemanggil yang punya baris DB menyimpannya sendiri).
 * - `InlineSpecReader`: rujukan `{ artifactId }` diselesaikan dari peta yang
 *   diberikan pemanggil; tanpa entri -> `ARTIFACT_NOT_FOUND` (bukan kueri DB).
 */
import { randomUUID } from "node:crypto";
import type { StudioOutputFormat } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { ArtifactSpecReader } from "../figures";
import { RenderJobHandle } from "../job";

/** Baris job sintetis: konstruktor `RenderJobHandle` hanya menyalin medan ini. */
type RenderJobRow = ConstructorParameters<typeof RenderJobHandle>[0];

export class DetachedRenderJob extends RenderJobHandle {
  /** Tidak pernah menyentuh DB; log dan galat tetap di memori job. */
  override persist(): Promise<void> {
    return Promise.resolve();
  }
}

/** Job render di memori. `id` dipakai sebagai correlationId log (juga job cetak PDF lewat render bridge, row 32). */
export function createDetachedJob(formats: readonly StudioOutputFormat[], id: string = `pure-${randomUUID()}`): DetachedRenderJob {
  const row = {
    id,
    documentId: null,
    revisionId: null,
    artifactId: null,
    formats: [...formats],
    queuedAt: new Date(),
  } as unknown as RenderJobRow;
  return new DetachedRenderJob(row);
}

/** Spec artefak yang disediakan pemanggil (pengganti baris StudioArtifact). */
export interface InlineArtifactSpec {
  kind: string;
  spec: unknown;
}

export class InlineSpecReader extends ArtifactSpecReader {
  private readonly specs: ReadonlyMap<string, InlineArtifactSpec>;

  constructor(specs?: ReadonlyMap<string, InlineArtifactSpec> | Readonly<Record<string, InlineArtifactSpec>>) {
    super();
    this.specs = specs instanceof Map ? specs : new Map(Object.entries(specs ?? {}));
  }

  override read(artifactId: string): Promise<{ kind: string; spec: unknown }> {
    const hit = this.specs.get(artifactId);
    if (!hit) {
      return Promise.reject(
        new StudioEngineError(
          "ARTIFACT_NOT_FOUND",
          `artifact ${artifactId} not provided to the DB-free renderer (pass it in opts.artifacts or inline the spec)`,
          { artifactId },
        ),
      );
    }
    return Promise.resolve({ kind: hit.kind, spec: hit.spec });
  }
}
