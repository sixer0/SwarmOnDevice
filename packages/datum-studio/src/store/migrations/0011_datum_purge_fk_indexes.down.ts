/**
 * Reverse step of migration 0011 (`20261117180000_datum_purge_fk_indexes`), Swarm 1.3.3 row 144 (ST-11).
 *
 * What it does: drops the four indexes 0011 created. Afterwards the schema is the schema 0010 left.
 *
 * What happens to data: nothing. An index holds no data of its own; every row of every table stays. The only
 * effect is speed: a revision purge falls back to full scans of `doc_block`, `doc_subsection` and `render_job`
 * (row 83: 17 minutes instead of about one minute on the real store). Hence no `downLossSql`, no `acceptDataLoss`,
 * and no `foreignKeysOff`. `IF EXISTS` mirrors the forward step's `IF NOT EXISTS`.
 */
export const MIGRATION_0011_DOWN_SQL = `-- datum-studio store, reverse of 20261117180000_datum_purge_fk_indexes (1.3.3 row 144).
DROP INDEX IF EXISTS render_job_revision_idx;
DROP INDEX IF EXISTS doc_subsection_revision_idx;
DROP INDEX IF EXISTS doc_block_doc_section_idx;
DROP INDEX IF EXISTS doc_block_chapter_idx;
`
