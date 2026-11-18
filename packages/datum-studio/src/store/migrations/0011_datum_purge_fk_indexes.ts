/**
 * Migration 0011 (`20261117180000_datum_purge_fk_indexes`), Swarm 1.3.3 row 144 (ST-11; finding of row 83,
 * implementation/83_st11_vacuum_and_rehearsal.md section 5.4 and decision 1).
 *
 * Four indexes on child columns of foreign keys that cascade when a revision is deleted. Without them SQLite
 * enforces each foreign key of a deleted parent row by scanning the whole child table, so a revision purge on the
 * real store (255,039 `doc_block` rows) took 17 minutes for 423 revisions, with single 100-revision batches of up
 * to 473 s against the store's 60 s transaction budget.
 *
 * The query each index serves is the child lookup SQLite runs, once per deleted parent row, to enforce
 * `ON DELETE CASCADE` (and the same lookup for the integrity check of a foreign key):
 *
 * | Index                         | Table.column              | Parent                | Lookup it serves                                  |
 * |-------------------------------|---------------------------|-----------------------|---------------------------------------------------|
 * | `doc_block_chapter_idx`       | `doc_block.chapter_id`    | `doc_chapter(id)`     | `SELECT … FROM doc_block WHERE chapter_id = ?`    |
 * | `doc_block_doc_section_idx`   | `doc_block.doc_section_id`| `doc_section(id)`     | `SELECT … FROM doc_block WHERE doc_section_id = ?`|
 * | `doc_subsection_revision_idx` | `doc_subsection.revision_id` | `revision(id)`     | `SELECT … FROM doc_subsection WHERE revision_id = ?` |
 * | `render_job_revision_idx`     | `render_job.revision_id`  | `revision(id)`        | `SELECT … FROM render_job WHERE revision_id = ?`  |
 *
 * The other large child tables on the cascade path from `revision` already have an index whose first column is the
 * child column (0001: UNIQUE constraints on `(revision_id, …)`, `(doc_section_id, …)`, `(chapter_id, …)`,
 * `doc_block_subsection_idx`, `block_revision_block_idx`). Three small ones still scan per deleted parent and are
 * left as they are (row 144 audit on the real store: `output_file.revision_id`, 818 rows, second column of
 * `output_file_doc_rev_idx`; `output_file.render_job_id`, 818 rows; `output_verification.render_job_id`, 686 rows).
 *
 * Additive only: four indexes, no table, no trigger, no row is written or changed. `IF NOT EXISTS`, so a store on
 * which an operator created an index of the same name by hand migrates without error (the hand-made index is then
 * kept as it is). Built at store open like every migration; measured on a copy of the real 1.84 GB store in the
 * row 144 report. Reverse step: `0011_datum_purge_fk_indexes.down.ts`. Do not edit: a change is a new migration.
 */
export const MIGRATION_0011_ID = "20261117180000_datum_purge_fk_indexes"

export const MIGRATION_0011_SQL = `-- datum-studio store, migration 20261117180000_datum_purge_fk_indexes (1.3.3 row 144, ST-11). Additive only; four indexes.
CREATE INDEX IF NOT EXISTS doc_block_chapter_idx ON doc_block(chapter_id);
CREATE INDEX IF NOT EXISTS doc_block_doc_section_idx ON doc_block(doc_section_id);
CREATE INDEX IF NOT EXISTS doc_subsection_revision_idx ON doc_subsection(revision_id);
CREATE INDEX IF NOT EXISTS render_job_revision_idx ON render_job(revision_id);
`

/** The four index names, in creation order (tests and the reverse step check against this list). */
/** @internal test seam */
export const MIGRATION_0011_INDEXES = ["doc_block_chapter_idx", "doc_block_doc_section_idx", "doc_subsection_revision_idx", "render_job_revision_idx"] as const
