/**
 * Migration 0005 (`20261108000000_datum_mission_gsp_tiers`), row 166 (user finding 2026-11-08: the model tier of a
 * mission row uses the GSP AI tiers of Swarm's bundled provider, packages/desktop/src/main/bundled-provider.ts:23-25,
 * not Claude Code's opus/sonnet).
 *
 * SQLite cannot change a CHECK in place, so `mission_row` is rebuilt (sqlite.org/lang_altertable.html, "other kinds of
 * table schema changes"): copy aside, drop, create with the new CHECKs, copy back with opus -> thinker,
 * sonnet -> worker, inherit kept, then re-create the 0003 indexes and triggers on it, unchanged. The rows are copied
 * back BEFORE the triggers exist, so the insert triggers (phase, kind, closed mission, search index) do not fire on
 * old rows. No rename is used, so no other table's FK or trigger text is rewritten.
 *
 * Runs with foreign keys off (`foreignKeysOff`, see index.ts): with them on, DROP TABLE would run the ON DELETE
 * CASCADE of mission_row_dep and mission_row_checkpoint and the RESTRICT of findings, locks, reports and messages.
 * The runner checks `PRAGMA foreign_key_check` before COMMIT. Everything is inside the runner's one BEGIN IMMEDIATE.
 *
 * Immutable history is not rewritten: mission_snapshot bodies and mission_event details written before this
 * migration keep the old words (the 0003 immutability triggers forbid changing them).
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0005_ID = "20261108000000_datum_mission_gsp_tiers"

/** Tiers in the order they rank; a row below thinker must say why (model_reason). */
export const MISSION_MODEL_TIERS = ["thinker", "worker", "worker-fast", "inherit"] as const

const COLS =
  "mission_id, row_id, phase_id, kind, title, agent, model_tier, model_reason, size, status, output, verification, " +
  "ownership_text, ownership_paths, resources, checks, review, note, decision_id, ord, " +
  "time_created, time_updated, time_started, time_finished"

export const MIGRATION_0005_SQL = `-- datum-studio store, migration 20261108000000_datum_mission_gsp_tiers (row 166). Rebuilds mission_row only.
CREATE TABLE mission_row_tier_0005 AS SELECT * FROM mission_row;
DROP TABLE mission_row;
CREATE TABLE mission_row (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL CHECK (length(row_id) BETWEEN 1 AND 5),
  phase_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL, agent TEXT NOT NULL,
  model_tier TEXT NOT NULL CHECK (model_tier IN ('thinker','worker','worker-fast','inherit')),
  model_reason TEXT CHECK (model_tier NOT IN ('worker','worker-fast') OR model_reason IS NOT NULL),
  size TEXT CHECK (size IS NULL OR size IN ('S','M')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','needs-review','blocked','done','dropped')),
  output TEXT NOT NULL, verification TEXT NOT NULL,
  ownership_text TEXT, ownership_paths TEXT CHECK (ownership_paths IS NULL OR json_valid(ownership_paths)),
  resources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resources)),
  checks TEXT, review TEXT NOT NULL DEFAULT 'gate' CHECK (review IN ('gate','none')),
  note TEXT CHECK (status NOT IN ('dropped','blocked') OR note IS NOT NULL),
  decision_id TEXT,
  ord INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_started INTEGER, time_finished INTEGER,
  CHECK (status IN ('done','dropped') OR size IS NOT NULL),
  PRIMARY KEY (mission_id, row_id),
  FOREIGN KEY (mission_id, decision_id) REFERENCES mission_decision(mission_id, decision_id) ON DELETE RESTRICT
) WITHOUT ROWID;
INSERT INTO mission_row (${COLS})
SELECT mission_id, row_id, phase_id, kind, title, agent,
  CASE model_tier WHEN 'opus' THEN 'thinker' WHEN 'sonnet' THEN 'worker' ELSE model_tier END,
  model_reason, size, status, output, verification, ownership_text, ownership_paths, resources, checks, review, note,
  decision_id, ord, time_created, time_updated, time_started, time_finished
FROM mission_row_tier_0005;
DROP TABLE mission_row_tier_0005;
CREATE INDEX mission_row_status ON mission_row(mission_id, status);
CREATE INDEX mission_row_agent ON mission_row(agent, status);
-- The 0003 triggers on mission_row, text unchanged (DROP TABLE removed them).
CREATE TRIGGER mission_row_phase_ins BEFORE INSERT ON mission_row
WHEN NOT EXISTS (SELECT 1 FROM mission m JOIN mission_type_phase p
                   ON p.type_id = m.type_id AND p.type_version = m.type_version AND p.phase_id = NEW.phase_id
                 WHERE m.id = NEW.mission_id)
BEGIN SELECT RAISE(ABORT, 'PHASE_UNKNOWN'); END;
CREATE TRIGGER mission_row_kind_ins BEFORE INSERT ON mission_row
WHEN EXISTS (SELECT 1 FROM mission m JOIN mission_type_phase p
               ON p.type_id = m.type_id AND p.type_version = m.type_version AND p.phase_id = NEW.phase_id
             WHERE m.id = NEW.mission_id)
 AND NOT EXISTS (SELECT 1 FROM mission m JOIN mission_type_phase p
                   ON p.type_id = m.type_id AND p.type_version = m.type_version AND p.phase_id = NEW.phase_id
                 JOIN json_each(p.kinds) k ON k.value = NEW.kind
                 WHERE m.id = NEW.mission_id)
BEGIN SELECT RAISE(ABORT, 'KIND_NOT_ALLOWED'); END;
CREATE TRIGGER mission_row_phase_upd BEFORE UPDATE OF phase_id, kind ON mission_row
WHEN NOT EXISTS (SELECT 1 FROM mission m JOIN mission_type_phase p
                   ON p.type_id = m.type_id AND p.type_version = m.type_version AND p.phase_id = NEW.phase_id
                 JOIN json_each(p.kinds) k ON k.value = NEW.kind
                 WHERE m.id = NEW.mission_id)
BEGIN SELECT RAISE(ABORT, 'KIND_NOT_ALLOWED'); END;
CREATE TRIGGER mission_closed_row BEFORE INSERT ON mission_row
WHEN (SELECT status FROM mission WHERE id = NEW.mission_id) IN ('done','cancelled')
BEGIN SELECT RAISE(ABORT, 'MISSION_CLOSED'); END;
CREATE TRIGGER mission_fts_row_ai AFTER INSERT ON mission_row BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.note, ''), NEW.mission_id, 'row', NEW.row_id); END;
CREATE TRIGGER mission_fts_row_au AFTER UPDATE OF title, note ON mission_row BEGIN
  DELETE FROM mission_fts WHERE mission_id = OLD.mission_id AND ref_kind = 'row' AND ref_id = OLD.row_id;
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.note, ''), NEW.mission_id, 'row', NEW.row_id); END;
`
