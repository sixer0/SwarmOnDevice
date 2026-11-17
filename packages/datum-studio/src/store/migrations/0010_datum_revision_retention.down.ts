/**
 * Reverse step of migration 0010 (`20261117120000_datum_revision_retention`), Swarm 1.3.3 row 82 (ST-11).
 *
 * What it does: drops the three triggers and the mark table. Afterwards the schema is the schema 0009 left.
 *
 * What happens to data:
 * - Kept: every revision and every row of every other table. The reverse step touches no revision.
 * - Discarded: the marks (`revision_prune` rows). A mark is not content: it is recomputed from the store by one
 *   `markRevisions` run after 0010 is applied again. Only the time of the mark is lost, which restarts the
 *   soft-delete window, so a revert can only delay a purge, never bring one forward. For that reason the step
 *   declares no `downLossSql` and needs no `acceptDataLoss`.
 * - Not restored: revisions a purge already removed. A purge is not part of this migration; it is undone only from
 *   its backup file (`restorePurgedRevisions`).
 * After the reverse step nothing in the schema refuses `DELETE FROM revision` any more (the state before 0010).
 * No foreign key points at `revision_prune`, so the step does not need `foreignKeysOff`.
 */
export const MIGRATION_0010_DOWN_SQL = `-- datum-studio store, reverse of 20261117120000_datum_revision_retention (1.3.3 row 82).
DROP TRIGGER revision_prune_unmark;
DROP TRIGGER revision_prune_referenced;
DROP TRIGGER revision_delete_guard;
DROP TABLE revision_prune;
`
