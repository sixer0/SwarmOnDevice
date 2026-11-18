/**
 * Migration 0010 (`20261117120000_datum_revision_retention`), Swarm 1.3.3 row 82 (ST-11; design
 * masterplan/04_st11_migration_design.md F3, decision C6).
 *
 * Schema for the soft-delete mark of revision retention. It deletes nothing and marks nothing: the marks are
 * written by `markRevisions` (store/revision-retention.ts) and a marked revision stays fully readable.
 *
 * - `revision_prune`: one row per marked revision. A side table, because every content column of `revision` is
 *   frozen by `revision_immutable` (0001); retention never updates `revision`, and that trigger is not touched.
 * - `revision_delete_guard` (BEFORE DELETE ON revision): 0001 protects a revision against UPDATE only, so until
 *   now nothing in the schema stopped a DELETE. From here on a revision can be deleted only when it carries a mark
 *   AND none of the structured references below points at it; anything else aborts with REVISION_IMMUTABLE. The
 *   one exception is the cascade of a deleted document (the document row is already gone when the cascade runs).
 * - `revision_prune_referenced` (BEFORE INSERT ON revision_prune): a mark is refused for a revision that a
 *   structured reference points at, whatever code writes the mark.
 * - `revision_prune_unmark` (AFTER INSERT ON mission_document): a mission link that arrives after the mark removes
 *   the mark at once.
 *
 * The structured references the two guards know (the database-side subset of the keep-set; the full rule, with the
 * references that need JSON walks or text, is `revisionKeepSet` in store/revision-retention.ts and is checked again
 * by the purge):
 *   1. the document's current revision (`document.current_revision_no`);
 *   2. a mission link (`mission_document`, 0007);
 *   3. a rendered output or a verification record of the revision (`output_file`, `output_verification`);
 *   4. a mission row's `deliverables` entry naming `{documentId, revisionNo}` (0009).
 *
 * Additive only: one table (with its implicit indexes) and three triggers. Reverse step:
 * `0010_datum_revision_retention.down.ts`. Do not edit: a change is a new migration.
 */
export const MIGRATION_0010_ID = "20261117120000_datum_revision_retention"

/** True when a structured reference points at the revision `(id, document_id, revision_no)` given by the three expressions. */
const referenced = (id: string, doc: string, no: string) => `(
     EXISTS (SELECT 1 FROM document d WHERE d.id = ${doc} AND d.current_revision_no = ${no})
  OR EXISTS (SELECT 1 FROM mission_document m WHERE m.document_id = ${doc} AND m.revision_no = ${no})
  OR EXISTS (SELECT 1 FROM output_file o WHERE o.revision_id = ${id})
  OR EXISTS (SELECT 1 FROM output_verification x WHERE x.revision_id = ${id})
  OR EXISTS (SELECT 1 FROM mission_row r, json_each(r.deliverables) j
              WHERE r.deliverables <> '[]'
                AND json_extract(j.value, '$.documentId') = ${doc}
                AND json_extract(j.value, '$.revisionNo') = ${no})
)`

export const MIGRATION_0010_SQL = `-- datum-studio store, migration 20261117120000_datum_revision_retention (1.3.3 row 82, ST-11). Additive only; deletes nothing.
CREATE TABLE revision_prune (
  revision_id TEXT PRIMARY KEY REFERENCES revision(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
  time_marked INTEGER NOT NULL,
  UNIQUE (document_id, revision_no)
) WITHOUT ROWID;
CREATE TRIGGER revision_delete_guard BEFORE DELETE ON revision
WHEN EXISTS (SELECT 1 FROM document d WHERE d.id = OLD.document_id)
 AND (NOT EXISTS (SELECT 1 FROM revision_prune p WHERE p.revision_id = OLD.id)
      OR ${referenced("OLD.id", "OLD.document_id", "OLD.revision_no")})
BEGIN SELECT RAISE(ABORT, 'REVISION_IMMUTABLE'); END;
CREATE TRIGGER revision_prune_referenced BEFORE INSERT ON revision_prune
WHEN NOT EXISTS (SELECT 1 FROM revision v WHERE v.id = NEW.revision_id AND v.document_id = NEW.document_id AND v.revision_no = NEW.revision_no)
  OR ${referenced("NEW.revision_id", "NEW.document_id", "NEW.revision_no")}
BEGIN SELECT RAISE(ABORT, 'REVISION_IMMUTABLE'); END;
CREATE TRIGGER revision_prune_unmark AFTER INSERT ON mission_document
BEGIN
  DELETE FROM revision_prune WHERE document_id = NEW.document_id AND revision_no = NEW.revision_no;
END;
`
