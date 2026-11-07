/**
 * Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 1): the clone's lazy Prisma
 * accessor for services/render (D-155). `db()` now returns the DATUM Studio store the host
 * installed (`setStudioStore`); render job rows are written through it (`job.ts`), artifacts are
 * gone (store spec M07: figures read inline specs only, `figures.ts`). Importing this module still
 * opens nothing: the store is looked up on the first call.
 */
import { studioStore, type SqliteStudioStore } from "../_swarm-store";

/** The process's DATUM Studio store, looked up on first use. */
export function db(): Promise<SqliteStudioStore> {
  return Promise.resolve().then(() => studioStore());
}
