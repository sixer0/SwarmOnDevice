/**
 * Migration 0006 (`20261108120000_datum_mission_autonomous_decision`), row 188 (decision L47, user decision L19).
 *
 * In autonomous mode the controller approves its own blueprint (L19). That decision is recorded honestly as
 * by: controller with `autonomous = 1` (never as by: user, S186-03), and studio_mission_approve accepts it only with
 * that mark. Additive only: one nullable column on mission_decision; no row, trigger or other table changes. The
 * column CHECK keeps the mark on controller decisions only, whatever code writes it.
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0006_ID = "20261108120000_datum_mission_autonomous_decision"

export const MIGRATION_0006_SQL = `-- datum-studio store, migration 20261108120000_datum_mission_autonomous_decision (row 188). Additive only.
ALTER TABLE mission_decision ADD COLUMN autonomous INTEGER CHECK (autonomous IS NULL OR (autonomous = 1 AND by = 'controller'));
`
