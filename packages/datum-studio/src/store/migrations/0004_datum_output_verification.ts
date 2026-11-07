/**
 * Migration 0004 (`20261107120000_datum_output_verification`), row 149 (decisions U24, C130).
 * The SQL is the DDL of masterplan/01_specs_output_verification.md §5, byte for byte (sha256
 * MIGRATION_0004_SPEC_SHA256; the test checks it). Additive only: one new table and two indexes,
 * no 0001-0003 table, trigger or row is changed. Needs 0001 (FKs to output_file, revision, render_job).
 * The table CHECK is the DB rule that UNKNOWN never counts as a pass: a `verified` record with any
 * FAIL or UNKNOWN check is refused by SQLite itself, whatever code writes it.
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0004_ID = "20261107120000_datum_output_verification"
export const MIGRATION_0004_SPEC_SHA256 = "b536df3fb5cb1681683b6da3aa9a69db095318ea941c5847b35be0374337bc76"

export const MIGRATION_0004_SQL = `-- datum-studio store, migration 20261107120000_datum_output_verification (row 148 spec §5, applied by row 149). Additive only.
CREATE TABLE output_verification (
  output_file_id TEXT PRIMARY KEY REFERENCES output_file(id) ON DELETE CASCADE,
  output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
  revision_id TEXT REFERENCES revision(id) ON DELETE CASCADE,
  render_job_id TEXT REFERENCES render_job(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('verified','unverified')),
  checks_version INTEGER NOT NULL CHECK (checks_version >= 1),
  fail_count INTEGER NOT NULL CHECK (fail_count >= 0),
  unknown_count INTEGER NOT NULL CHECK (unknown_count >= 0),
  report TEXT NOT NULL CHECK (json_valid(report)),
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  verified_by TEXT NOT NULL,
  time_verified INTEGER NOT NULL,
  CHECK (state = 'unverified' OR (fail_count = 0 AND unknown_count = 0))
);
CREATE INDEX output_verification_revision_idx ON output_verification(revision_id);
CREATE INDEX output_verification_state_idx ON output_verification(state);
`
