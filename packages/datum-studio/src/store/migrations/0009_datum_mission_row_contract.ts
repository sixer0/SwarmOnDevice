/**
 * Migration 0009 (`20261117000000_datum_mission_row_contract`), Swarm 1.3.3 row 5 (register section 1, decision C6).
 *
 * The mission row gains three host fields, each stored as JSON text in its own column of `mission_row`:
 * - `deliverables`: the files of the row in the project folder (MC-8). A list, so NOT NULL with default '[]'.
 * - `knowledge`: the library domains matched for the row, the files read, and the waiver reason (KL-2). NULL = no
 *   domain matched.
 * - `awaiting_human_check`: the checks a person still owes on the row's document (MC-5, ST-9). NULL = none.
 * Shape and limits are checked by the row schema (`studio.mission/v1#/$defs/Row`) in the store setters; the columns
 * only guarantee valid JSON, like `resources` (0003).
 *
 * Additive only: three ADD COLUMN, no rebuild, no trigger and no index change. Rows written before this migration
 * read as deliverables '[]', knowledge NULL, awaiting_human_check NULL. The existing triggers on `mission_row` name
 * their columns (`UPDATE OF phase_id, kind`, `UPDATE OF title, note`), so a write of the new columns fires none.
 * Reverse step (row 81 adds the runner support): drop the three columns.
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0009_ID = "20261117000000_datum_mission_row_contract"

export const MIGRATION_0009_SQL = `-- datum-studio store, migration 20261117000000_datum_mission_row_contract (1.3.3 row 5). Additive only.
ALTER TABLE mission_row ADD COLUMN deliverables TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deliverables));
ALTER TABLE mission_row ADD COLUMN knowledge TEXT CHECK (knowledge IS NULL OR json_valid(knowledge));
ALTER TABLE mission_row ADD COLUMN awaiting_human_check TEXT CHECK (awaiting_human_check IS NULL OR json_valid(awaiting_human_check));
`
