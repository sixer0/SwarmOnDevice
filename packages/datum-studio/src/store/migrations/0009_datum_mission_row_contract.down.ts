/**
 * Reverse step of migration 0009 (`20261117000000_datum_mission_row_contract`), Swarm 1.3.3 row 81 (ST-11).
 * The forward file is not edited; this file only undoes it.
 *
 * What it does: drops the three columns 0009 added to `mission_row`. No table rebuild: SQLite removes a column in
 * place when it is not indexed, not part of a key, and no trigger or view names it, which holds for all three
 * (0009 added no index and no trigger). Afterwards the schema text of `mission_row` is the text it had before 0009.
 *
 * What happens to data:
 * - Kept: every other column of every mission row, and every other table.
 * - Discarded: the values of `deliverables`, `knowledge` and `awaiting_human_check`. They are not copied anywhere;
 *   applying 0009 again brings the columns back empty ('[]', NULL, NULL). The files a deliverable entry points at
 *   stay on disk; only the row's list of them is lost.
 * The runner therefore counts the rows that carry a value (MIGRATION_0009_DOWN_LOSS_SQL) and refuses the reversal
 * when the count is above zero, unless the operator passes `acceptDataLoss: true`.
 */
export const MIGRATION_0009_DOWN_SQL = `-- datum-studio store, reverse of 20261117000000_datum_mission_row_contract (1.3.3 row 81).
ALTER TABLE mission_row DROP COLUMN awaiting_human_check;
ALTER TABLE mission_row DROP COLUMN knowledge;
ALTER TABLE mission_row DROP COLUMN deliverables;
`

/** One row `n`: mission rows whose value in one of the three columns would be discarded. */
export const MIGRATION_0009_DOWN_LOSS_SQL = `SELECT count(*) AS n FROM mission_row WHERE deliverables <> '[]' OR knowledge IS NOT NULL OR awaiting_human_check IS NOT NULL`
