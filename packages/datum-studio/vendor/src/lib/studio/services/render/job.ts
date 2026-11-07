/**
 * Siklus hidup StudioRenderJob (S51, M09): QUEUED -> RUNNING (-> QUEUED saat
 * menunggu slot soffice -> RUNNING) -> SUCCEEDED | PARTIAL | FAILED.
 *
 * Kolom `engine` (Json) memuat `{ sofficeVersion, chromiumRevision,
 * renderEnvManifestSha256, errors, log, logDropped }`; `log` adalah sink log
 * tahan lama job (F-020). DTO hanya mengekspos tiga kunci mesin + `errors`.
 *
 * Swarm patch (row 109, Prisma cut; 01_specs_studio.md §1.2 site 1): `render_job` rows of the
 * DATUM Studio store. The job is created with `StudioStore.recordRender`; status/engine updates
 * write only the given columns; the active-job guard reads the table (plus the in-process set).
 */
import { msOf, renderJobOf, withStudioTx, type StudioJson, type StudioRenderJob } from "../_swarm-store";
import {
  STUDIO_RENDER_JOB_TIMEOUT_MS,
  type RenderJobDto,
  type RenderScope,
  type StudioRenderScopeKind,
  type RenderJobError,
  type StudioErrorCode,
  type StudioOutputFormat,
  type StudioRenderJobStatus,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { db } from "./db";

/** Columns a job update may set (was `Prisma.StudioRenderJobUpdateInput` minus `engine`). */
export interface RenderJobPatch {
  status?: StudioRenderJobStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  durationMs?: number | null;
}
import { JobLog, RENDER_MODULE, registerJobLog, unregisterJobLog } from "./joblog";

export interface JobEngineInfo {
  sofficeVersion?: string;
  chromiumRevision?: string;
  renderEnvManifestSha256?: string;
}

export interface JobTarget {
  documentId?: string;
  revisionId?: string;
  artifactId?: string;
  /**
   * Lingkup render revisi (SR-15, kolom MX05 `scopeKind`/`scopeKey`); absen =
   * DOCUMENT. Lingkup berbeda pada revisi yang sama menulis ke direktori berbeda
   * (`rev-<n>/` vs `rev-<n>/bab-<k>/`), jadi tidak saling mengunci.
   */
  scope?: RenderScope;
}

/** Kolom DB lingkup job (MX05): DOCUMENT -> kunci null. */
export function scopeColumns(scope: RenderScope | undefined): { scopeKind: StudioRenderScopeKind; scopeKey: string | null } {
  if (!scope || scope.kind === "DOCUMENT") return { scopeKind: "DOCUMENT", scopeKey: null };
  return { scopeKind: scope.kind, scopeKey: scope.key };
}

/** Pegangan job berjalan: status, galat per format, log. */
export class RenderJobHandle {
  readonly id: string;
  readonly target: JobTarget;
  readonly formats: StudioOutputFormat[];
  readonly log: JobLog;
  readonly errors: RenderJobError[] = [];
  readonly engine: JobEngineInfo = {};
  readonly queuedAt: Date;
  startedAt: Date | null = null;
  status: StudioRenderJobStatus = "QUEUED";
  /** true setelah batas waktu job (C08): tahap berikutnya tidak menulis berkas. */
  aborted = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(row: StudioRenderJob) {
    this.id = row.id;
    const scopeKind = (row as Partial<StudioRenderJob>).scopeKind;
    const scopeKey = (row as Partial<StudioRenderJob>).scopeKey;
    this.target = {
      documentId: row.documentId ?? undefined,
      revisionId: row.revisionId ?? undefined,
      artifactId: row.artifactId ?? undefined,
      ...(scopeKind && scopeKind !== "DOCUMENT" && scopeKey ? { scope: { kind: scopeKind, key: scopeKey } } : {}),
    };
    this.formats = [...row.formats] as StudioOutputFormat[];
    this.queuedAt = row.queuedAt;
    this.log = new JobLog(row.id);
  }

  addError(code: StudioErrorCode, message: string, format?: StudioOutputFormat, err?: unknown): void {
    const e: RenderJobError = { code, message };
    if (format) e.format = format;
    this.errors.push(e);
    this.log.error(format ? `[${format}] ${message}` : message, { code, err });
  }

  /** Lempar RENDER_TIMEOUT bila job sudah melewati batas waktu. */
  checkAborted(stage: string): void {
    if (this.aborted) throw new StudioEngineError("RENDER_TIMEOUT", `render job timed out before stage ${stage}`, { jobId: this.id });
  }

  engineJson(): StudioJson {
    const snap = this.log.snapshot();
    return JSON.parse(JSON.stringify({ ...this.engine, errors: this.errors, log: snap.entries, logDropped: snap.dropped })) as StudioJson;
  }

  /** Tulis status + engine/log ke DB secara berurutan (tidak pernah melempar). */
  persist(data: RenderJobPatch = {}): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await db();
        const sets = ["engine = ?"];
        const vals: Array<string | number | null> = [JSON.stringify(this.engineJson())];
        if (data.status !== undefined) (sets.push("status = ?"), vals.push(data.status));
        if (data.errorCode !== undefined) (sets.push("error_code = ?"), vals.push(data.errorCode));
        if (data.errorMessage !== undefined) (sets.push("error_message = ?"), vals.push(data.errorMessage));
        if (data.startedAt !== undefined) (sets.push("time_started = ?"), vals.push(msOf(data.startedAt)));
        if (data.finishedAt !== undefined) (sets.push("time_finished = ?"), vals.push(msOf(data.finishedAt)));
        if (data.durationMs !== undefined) (sets.push("duration_ms = ?"), vals.push(data.durationMs));
        await withStudioTx(async (tx) => {
          tx.run(`UPDATE render_job SET ${sets.join(", ")} WHERE id = ?`, [...vals, this.id]);
        });
      } catch (err) {
        // DB tak terjangkau: satu-satunya jalur yang tersisa adalah stderr.
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            source: RENDER_MODULE,
            message: "render job persist failed",
            correlationId: this.id,
            stack_trace: err instanceof Error ? err.stack : String(err),
          }),
        );
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next;
    return next;
  }

  async setStatus(status: StudioRenderJobStatus): Promise<void> {
    if (this.status === status) return;
    this.status = status;
    await this.persist({ status });
  }
}

/** Sasaran yang sedang dirender di proses ini (penjaga RENDER_IN_PROGRESS). */
const inProcess = new Set<string>();

function targetKey(t: JobTarget): string {
  if (!t.revisionId) return `art:${t.artifactId ?? ""}`;
  const c = scopeColumns(t.scope);
  return c.scopeKind === "DOCUMENT" ? `rev:${t.revisionId}` : `rev:${t.revisionId}:${c.scopeKind}:${c.scopeKey}`;
}

/**
 * Penjaga RENDER_IN_PROGRESS SATU sumber (S85 R-04): job QUEUED/RUNNING
 * untuk sasaran yang sama di proses ini, atau di DB yang belum basi (C08,
 * `queuedAt >= now - STUDIO_RENDER_JOB_TIMEOUT_MS`). Job yatim akibat proses
 * mati tidak mengunci sasaran selamanya. Melempar `RENDER_IN_PROGRESS` (409).
 */
export async function assertNoActiveRenderJob(target: JobTarget): Promise<void> {
  if (inProcess.has(targetKey(target))) {
    throw new StudioEngineError("RENDER_IN_PROGRESS", "a render job for this target is already running", { target });
  }
  const freshSince = Date.now() - STUDIO_RENDER_JOB_TIMEOUT_MS;
  // Artifact targets (M07) have no rows in the store: only the in-process guard applies to them.
  await db();
  const sc = scopeColumns(target.scope);
  const running = target.revisionId
    ? await withStudioTx(async (tx) =>
        tx.get<{ id: string }>(
          `SELECT id FROM render_job WHERE status IN ('QUEUED','RUNNING') AND time_queued >= ? AND revision_id = ? AND scope_kind = ? AND scope_key IS ? LIMIT 1`,
          [freshSince, target.revisionId!, sc.scopeKind, sc.scopeKey],
        ),
      )
    : undefined;
  if (running) {
    throw new StudioEngineError("RENDER_IN_PROGRESS", "a render job for this target is already queued or running", { jobId: running.id });
  }
}

/**
 * Buat job QUEUED. Melempar RENDER_IN_PROGRESS bila sasaran yang sama sedang
 * dirender (`assertNoActiveRenderJob`).
 */
export async function createRenderJob(target: JobTarget, formats: StudioOutputFormat[], requestedBy: string): Promise<RenderJobHandle> {
  const key = targetKey(target);
  await assertNoActiveRenderJob(target);
  if (inProcess.has(key)) {
    throw new StudioEngineError("RENDER_IN_PROGRESS", "a render job for this target is already running", { target });
  }
  inProcess.add(key);
  try {
    if (!target.revisionId) {
      throw new StudioEngineError("ARTIFACT_NOT_FOUND", "standalone artifacts are not available in DATUM Studio for Swarm", { artifactId: target.artifactId ?? null });
    }
    const store = await db();
    const sc = scopeColumns(target.scope);
    const row = await withStudioTx(async (tx) => {
      const id = (await import("../_swarm-store")).newId();
      await store.recordRender(tx, {
        id,
        documentId: target.documentId ?? null,
        revisionId: target.revisionId ?? null,
        formats,
        status: "QUEUED",
        requestedBy,
        scopeKind: sc.scopeKind,
        scopeKey: sc.scopeKey,
      });
      return renderJobOf(tx.get("SELECT * FROM render_job WHERE id = ?", [id])!);
    });
    const job = new RenderJobHandle(row);
    registerJobLog(job.log);
    job.log.info("render job queued", { code: "RENDER_JOB_QUEUED", context: { formats, target } });
    return job;
  } catch (err) {
    inProcess.delete(key);
    throw err;
  }
}

/** Lepas penjaga proses + log aktif (dipanggil di `finally`). */
export function releaseRenderJob(job: RenderJobHandle): void {
  inProcess.delete(targetKey(job.target));
  unregisterJobLog(job.log);
}

/** Status akhir dari hasil per format. */
export function finalStatus(requested: number, produced: number, errors: number): StudioRenderJobStatus {
  if (produced === 0 && requested > 0) return "FAILED";
  if (errors > 0) return "PARTIAL";
  return "SUCCEEDED";
}

export async function finishRenderJob(job: RenderJobHandle, status: StudioRenderJobStatus): Promise<StudioRenderJob> {
  job.status = status;
  const finishedAt = new Date();
  const startedAt = job.startedAt ?? finishedAt;
  const first = job.errors[0];
  const errorMessage = job.errors.length
    ? job.errors.map((e) => `${e.format ? `[${e.format}] ` : ""}${e.code}: ${e.message ?? ""}`.trim()).join("\n").slice(0, 8000)
    : null;
  job.log.info(`render job ${status.toLowerCase()}`, { code: `RENDER_JOB_${status}`, context: { errors: job.errors.length } });
  await job.persist({
    status,
    errorCode: first ? first.code : null,
    errorMessage,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  });
  await db();
  const raw = await withStudioTx(async (tx) => tx.get("SELECT * FROM render_job WHERE id = ?", [job.id]));
  if (!raw) throw new StudioEngineError("FILE_NOT_FOUND", "render job row vanished", { jobId: job.id });
  const row = renderJobOf(raw);
  return row;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Peta baris DB -> DTO kontrak (`engine` hanya tiga kunci mesin). */
export function renderJobToDto(row: StudioRenderJob): RenderJobDto {
  const eng = isRecord(row.engine) ? row.engine : null;
  const pick = (k: string): string | undefined => (eng && typeof eng[k] === "string" ? (eng[k] as string) : undefined);
  const engine = eng
    ? {
        ...(pick("sofficeVersion") ? { sofficeVersion: pick("sofficeVersion") } : {}),
        ...(pick("chromiumRevision") ? { chromiumRevision: pick("chromiumRevision") } : {}),
        ...(pick("renderEnvManifestSha256") ? { renderEnvManifestSha256: pick("renderEnvManifestSha256") } : {}),
      }
    : null;
  const errors = eng && Array.isArray(eng.errors) ? (eng.errors as unknown as RenderJobError[]) : undefined;
  const dto: RenderJobDto = {
    id: row.id,
    documentId: row.documentId,
    revisionId: row.revisionId,
    artifactId: row.artifactId,
    formats: [...row.formats] as StudioOutputFormat[],
    status: row.status as StudioRenderJobStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    engine,
    requestedBy: row.requestedBy,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
  };
  if (errors && errors.length) dto.errors = errors;
  return dto;
}

/**
 * Jalankan `work` dengan batas waktu job (C08). Saat lewat, job ditandai
 * `aborted` (tahap berikutnya berhenti sebelum menulis) dan RENDER_TIMEOUT
 * dilempar ke pemanggil.
 */
export async function withJobTimeout<T>(job: RenderJobHandle, work: () => Promise<T>, timeoutMs = STUDIO_RENDER_JOB_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      job.aborted = true;
      reject(new StudioEngineError("RENDER_TIMEOUT", `render job exceeded ${timeoutMs} ms`, { jobId: job.id }));
    }, timeoutMs);
  });
  const running = work();
  // Hasil kerja yang terlambat tetap ditangkap agar tidak menjadi unhandled rejection.
  running.catch((err: unknown) => {
    if (job.aborted) job.log.warn("late failure after job timeout", { context: { detail: err instanceof Error ? err.message : String(err) } });
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
