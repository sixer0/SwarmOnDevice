/**
 * Migration 0002 (`20261106120000_datum_template_guard`), row 64.
 * DDL = the row 63 store note, masterplan/01_specs_studio_templates.md §5.5, statement for statement.
 * Additive only (store spec §7.3): three nullable columns on `template_version` and one index.
 * No row is rewritten: `ALTER TABLE … ADD COLUMN` does not fire the 0001 triggers, and every
 * existing version (builtin pins and pre-0002 user versions) reads NULL in the new columns.
 * The 0001 trigger `template_version_immutable` (BEFORE UPDATE, no column list) also covers the new
 * columns, so they can only be written at INSERT.
 * Column meaning of `guard_skill_sha` per row 79 (names register R9): sha256 of Studio's lint closure
 * as shipped; the CHECK (length 64) is unchanged.
 * Id below 0003 `20261107000000_datum_mission` (mission contract §7, row 118 request), so ids stay in order.
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0002_ID = "20261106120000_datum_template_guard"

export const MIGRATION_0002_SQL = `-- datum-studio store, migration 20261106120000_datum_template_guard (row 63 note, applied by row 64)
ALTER TABLE template_version ADD COLUMN guard_verdict TEXT
  CHECK (guard_verdict IS NULL OR guard_verdict IN ('pass','warn'));
ALTER TABLE template_version ADD COLUMN guard_report TEXT;
ALTER TABLE template_version ADD COLUMN guard_skill_sha TEXT
  CHECK (guard_skill_sha IS NULL OR length(guard_skill_sha) = 64);
CREATE INDEX template_version_guard_verdict ON template_version(guard_verdict);
`
