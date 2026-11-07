/**
 * Cek tautan misi (S52, I42 `assertMissionRefs`). KD-01: kolom string tanpa
 * FK, jadi keberadaan dicek di layanan:
 * - `agentRequestId` -> baris `AgentRequest`;
 * - `hermesTaskId` -> baris `HermesTask`;
 * - `folder` -> format §7.2, lalu keberadaan direktori `docs/<folder>` di
 *   `SHARED_WORKSPACE` (HANYA `stat`, tidak pernah menulis; KT-03) atau di
 *   akar Studio. Bila `SHARED_WORKSPACE` tidak disetel, keberadaan hanya dicek
 *   di akar Studio; folder belum ada di sana diterima dengan peringatan log
 *   (akar sandbox membuatnya saat tulis pertama).
 * Gagal -> `MISSION_REF_NOT_FOUND` (404) dengan `details.field`.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { StudioDocV1 } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { errorFields, storageLog } from "./log";
import { DOCS_DIR, missionDirName, storageRoot } from "./paths";

const MAX_REF_CHARS = 200;

// Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 7): the HQ tables `AgentRequest`
// and `HermesTask` are not part of Swarm (store spec §1: Studio models only), so a reference to
// them cannot be verified here. They stay plain labels on the document (`agent_request_id`,
// `hermes_task_id`): the format check below still runs, and an unverified reference is logged
// (warn `MISSION_REF_UNVERIFIED`), not refused - the same rule the clone applies to an
// unverifiable mission folder (`MISSION_FOLDER_UNVERIFIED`).
function unverifiedRef(field: string): void {
  storageLog({ level: "warn", message: `${field} not verifiable in Swarm (no HQ table); accepted as a label`, code: "MISSION_REF_UNVERIFIED", context: { field } });
}

function notFound(field: string, message: string): StudioEngineError {
  return new StudioEngineError("MISSION_REF_NOT_FOUND", message, { field });
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

function checkRefString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_REF_CHARS) {
    throw notFound(field, `${field} is not a valid reference`);
  }
  return v;
}

async function assertFolderExists(folder: string): Promise<void> {
  // Format (melempar MISSION_REF_NOT_FOUND bila salah).
  missionDirName(folder, "");
  const studioCandidate = path.join(storageRoot(), DOCS_DIR, folder);
  const sharedRaw = process.env.SHARED_WORKSPACE?.trim();
  // Swarm patch (row 109, left open by rows 107/29; studio spec §2 C): no cwd fallback. A
  // SHARED_WORKSPACE that is set must be absolute, else STORAGE_ROOT_FORBIDDEN (fail closed).
  if (sharedRaw && !path.isAbsolute(sharedRaw)) {
    throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", "SHARED_WORKSPACE must be an absolute path (no cwd fallback)");
  }
  const candidates = sharedRaw ? [path.resolve(sharedRaw, DOCS_DIR, folder), studioCandidate] : [studioCandidate];
  for (const c of candidates) {
    if (await isDirectory(c)) return;
  }
  if (!sharedRaw) {
    storageLog({
      level: "warn",
      message: "mission folder not verifiable (SHARED_WORKSPACE unset); accepted for sandbox root",
      code: "MISSION_FOLDER_UNVERIFIED",
      context: { folder },
    });
    return;
  }
  throw notFound("mission.folder", "mission.folder does not exist");
}

/** I42: tolak tautan misi yang tidak ada. `undefined` = tanpa tautan (lolos). */
export async function assertMissionRefs(m: StudioDocV1["mission"]): Promise<void> {
  if (m === undefined || m === null) return;
  try {
    if (m.folder !== undefined) await assertFolderExists(checkRefString(m.folder, "mission.folder"));
    if (m.agentRequestId !== undefined) {
      checkRefString(m.agentRequestId, "mission.agentRequestId");
      unverifiedRef("mission.agentRequestId");
    }
    if (m.hermesTaskId !== undefined) {
      checkRefString(m.hermesTaskId, "mission.hermesTaskId");
      unverifiedRef("mission.hermesTaskId");
    }
  } catch (err) {
    if (err instanceof StudioEngineError) throw err;
    storageLog({ level: "error", message: "mission reference check failed", code: "MISSION_CHECK_FAILED", ...errorFields(err) });
    throw err;
  }
}
