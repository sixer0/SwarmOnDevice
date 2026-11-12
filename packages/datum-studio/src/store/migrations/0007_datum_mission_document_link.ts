/**
 * Migration 0007 (`20261112000000_datum_mission_document_link`), Swarm 1.2.6 row 86 (MC-08, register N-065, U5).
 *
 * A document belongs to the mission named in `document.mission_folder` (its owner). Work done under another mission
 * on that document (mission B revises a document mission A owns) was invisible to B: `studio_mission_get include:
 * deliverables` listed only owned documents. `mission_document` links a document revision to the mission that
 * produced it, whoever owns the document. The deliverables read (mcp-host/mission/deliverables.ts) lists a linked
 * document with its linked revision.
 *
 * Source of a link: the contract's own vocabulary. A work report of mission M (a `mission_report` row) that names a
 * document in its references with rel `output` (`## Rujukan` table, "keluaran" / "hasil" / "output"; stored by
 * ingest in `doc_ref`) says "this row of M produced that revision". Two triggers keep the link table equal to that
 * fact, whatever code path writes the report, so the mission store and the report tools are not changed:
 * - `mission_document_from_ref`: a new `doc_ref` (rel output) of a document that already is a mission report
 *   (studio_report_update / a rewrite of a linked report).
 * - `mission_document_from_report`: a new `mission_report` row (studio_report_submit and the guarded creates link the
 *   report AFTER ingest stored its refs) links the refs the report document already holds.
 * Revision: the reference's revision, else the target's current revision at link time; a reference to a document or
 * revision that does not exist links nothing (no error: the report tools own reference validation). A backfill links
 * the refs of reports stored before this migration (time_linked = the report link time).
 *
 * Additive only: one table, one index, two triggers. Do not edit: a change is a new migration.
 */
export const MIGRATION_0007_ID = "20261112000000_datum_mission_document_link"

/** Milliseconds since the epoch inside SQLite (the store keeps every time as integer ms). */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

export const MIGRATION_0007_SQL = `-- datum-studio store, migration 20261112000000_datum_mission_document_link (1.2.6 row 86, MC-08). Additive only.
CREATE TABLE mission_document (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  row_id TEXT,
  time_linked INTEGER NOT NULL,
  PRIMARY KEY (mission_id, document_id, revision_no)
) WITHOUT ROWID;
CREATE INDEX mission_document_by_document ON mission_document(document_id, revision_no);
CREATE TRIGGER mission_document_from_ref AFTER INSERT ON doc_ref WHEN NEW.rel = 'output'
BEGIN
  INSERT OR IGNORE INTO mission_document (mission_id, document_id, revision_no, row_id, time_linked)
  SELECT r.mission_id, d.id, coalesce(NEW.target_revision_no, d.current_revision_no), r.row_id, ${NOW_MS}
    FROM mission_report r JOIN document d ON d.id = NEW.target_document_id
   WHERE r.document_id = NEW.from_document_id
     AND EXISTS (SELECT 1 FROM revision v WHERE v.document_id = d.id AND v.revision_no = coalesce(NEW.target_revision_no, d.current_revision_no));
END;
CREATE TRIGGER mission_document_from_report AFTER INSERT ON mission_report
BEGIN
  INSERT OR IGNORE INTO mission_document (mission_id, document_id, revision_no, row_id, time_linked)
  SELECT NEW.mission_id, d.id, coalesce(f.target_revision_no, d.current_revision_no), NEW.row_id, ${NOW_MS}
    FROM doc_ref f JOIN document d ON d.id = f.target_document_id
   WHERE f.from_document_id = NEW.document_id AND f.rel = 'output'
     AND EXISTS (SELECT 1 FROM revision v WHERE v.document_id = d.id AND v.revision_no = coalesce(f.target_revision_no, d.current_revision_no));
END;
INSERT OR IGNORE INTO mission_document (mission_id, document_id, revision_no, row_id, time_linked)
SELECT r.mission_id, d.id, coalesce(f.target_revision_no, d.current_revision_no), r.row_id, r.time_created
  FROM mission_report r JOIN doc_ref f ON f.from_document_id = r.document_id AND f.rel = 'output'
  JOIN document d ON d.id = f.target_document_id
 WHERE EXISTS (SELECT 1 FROM revision v WHERE v.document_id = d.id AND v.revision_no = coalesce(f.target_revision_no, d.current_revision_no));
`
