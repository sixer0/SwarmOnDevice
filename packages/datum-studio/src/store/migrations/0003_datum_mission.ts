/**
 * Migration 0003 (`20261107000000_datum_mission`), row 119a (decisions U19, U20, C57, C68).
 * Part 1 is the DDL of masterplan/01_specs_mission_contract.md §7.2, byte for byte (the row 118 probe file
 * /private/tmp/claude-501/row118/schema/0003_datum_mission.sql, sha256 MIGRATION_0003_SPEC_SHA256; the test checks it).
 * Part 2 adds the C57 entities (decision requests, row checkpoints, message log incl. owner instructions) in the
 * same style. Additive only: no 0001/0002 table is changed. Needs 0001 (FK to `document`).
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0003_ID = "20261107000000_datum_mission"
export const MIGRATION_0003_SPEC_SHA256 = "3b9612e1398ab1df5a89134b601ae133db30f9f961e233f87a2cd1e52cb80709"

export const MIGRATION_0003_SPEC_SQL = `-- Migration 0003 \`20261107000000_datum_mission\` (row 119). Additive only; needs 0001 (table document).
CREATE TABLE mission_type (
  id TEXT NOT NULL CHECK (id GLOB '[a-z]*' AND length(id) <= 32),
  version INTEGER NOT NULL CHECK (version >= 1),
  name_id TEXT NOT NULL, name_en TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64),
  time_created INTEGER NOT NULL,
  PRIMARY KEY (id, version)
) WITHOUT ROWID;
CREATE TABLE mission_type_phase (
  type_id TEXT NOT NULL, type_version INTEGER NOT NULL,
  phase_id TEXT NOT NULL, ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 12),
  name_id TEXT NOT NULL, name_en TEXT NOT NULL,
  kinds TEXT NOT NULL CHECK (json_valid(kinds) AND json_type(kinds) = 'array'),
  PRIMARY KEY (type_id, type_version, phase_id),
  UNIQUE (type_id, type_version, ord),
  FOREIGN KEY (type_id, type_version) REFERENCES mission_type(id, version) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE mission (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type_id TEXT NOT NULL, type_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','running','paused','done','cancelled')),
  superseded_by TEXT REFERENCES mission(id) ON DELETE RESTRICT CHECK (superseded_by IS NULL OR (superseded_by <> id AND status = 'cancelled')),
  owner TEXT NOT NULL,
  project_dir TEXT NOT NULL CHECK (substr(project_dir, 1, 1) = '/'),
  swarm_project_id TEXT,
  approval_decision_id TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_approved INTEGER, time_closed INTEGER,
  CHECK ((status IN ('approved','running','paused','done')) = (time_approved IS NOT NULL AND approval_decision_id IS NOT NULL) OR status = 'cancelled'),
  CHECK ((status IN ('done','cancelled')) = (time_closed IS NOT NULL)),
  FOREIGN KEY (type_id, type_version) REFERENCES mission_type(id, version) ON DELETE RESTRICT
);
CREATE INDEX mission_status ON mission(status, time_updated DESC);
CREATE INDEX mission_project ON mission(project_dir);
CREATE TABLE mission_session (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK (client IN ('swarm','claude')),
  session_ref TEXT NOT NULL CHECK (length(session_ref) BETWEEN 1 AND 128),
  role TEXT CHECK (role IS NULL OR role IN ('controller','driver','viewer')),
  time_linked INTEGER NOT NULL,
  PRIMARY KEY (mission_id, client, session_ref)
) WITHOUT ROWID;
CREATE INDEX mission_session_by_session ON mission_session(client, session_ref);
CREATE TABLE mission_decision (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL CHECK (decision_id GLOB '[UC][1-9]*'),
  by TEXT NOT NULL CHECK (by IN ('user','controller')),
  date TEXT NOT NULL CHECK (date(date) = date),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  rows TEXT CHECK (rows IS NULL OR json_valid(rows)),
  supersedes TEXT CHECK (supersedes IS NULL OR json_valid(supersedes)),
  time_created INTEGER NOT NULL,
  CHECK ((by = 'user') = (substr(decision_id, 1, 1) = 'U')),
  PRIMARY KEY (mission_id, decision_id)
) WITHOUT ROWID;
CREATE TABLE mission_row (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL CHECK (length(row_id) BETWEEN 1 AND 5),
  phase_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL, agent TEXT NOT NULL,
  model_tier TEXT NOT NULL CHECK (model_tier IN ('opus','sonnet','inherit')),
  model_reason TEXT CHECK (model_tier <> 'sonnet' OR model_reason IS NOT NULL),
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
CREATE INDEX mission_row_status ON mission_row(mission_id, status);
CREATE INDEX mission_row_agent ON mission_row(agent, status);
CREATE TABLE mission_row_dep (
  mission_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  dep_row_id TEXT NOT NULL CHECK (dep_row_id <> row_id),
  kind TEXT NOT NULL CHECK (kind IN ('B','C')),
  position INTEGER NOT NULL CHECK (position >= 1),
  PRIMARY KEY (mission_id, row_id, dep_row_id),
  UNIQUE (mission_id, row_id, position),
  FOREIGN KEY (mission_id, row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id, dep_row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX mission_row_dep_reverse ON mission_row_dep(mission_id, dep_row_id);
CREATE TABLE mission_finding (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL CHECK (length(finding_id) BETWEEN 1 AND 64),
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title TEXT NOT NULL,
  source_row TEXT NOT NULL, owner_row TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','fixed','accepted','deferred')),
  decision_id TEXT CHECK (status NOT IN ('accepted','deferred') OR decision_id IS NOT NULL),
  evidence TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  CHECK (status <> 'open' OR owner_row IS NOT NULL),
  PRIMARY KEY (mission_id, finding_id),
  FOREIGN KEY (mission_id, source_row) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT,
  FOREIGN KEY (mission_id, owner_row) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT,
  FOREIGN KEY (mission_id, decision_id) REFERENCES mission_decision(mission_id, decision_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX mission_finding_open ON mission_finding(mission_id, status, severity);
CREATE TABLE mission_lock (
  seq INTEGER PRIMARY KEY,
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 80),
  mission_id TEXT NOT NULL, row_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  time_acquired INTEGER NOT NULL, time_released INTEGER CHECK (time_released IS NULL OR time_released >= time_acquired),
  FOREIGN KEY (mission_id, row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX mission_lock_held ON mission_lock(resource) WHERE time_released IS NULL;
CREATE TABLE mission_report (
  document_id TEXT PRIMARY KEY REFERENCES document(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('row','delegation')),
  row_id TEXT CHECK ((kind = 'row') = (row_id IS NOT NULL)),
  time_created INTEGER NOT NULL,
  FOREIGN KEY (mission_id, row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX mission_report_row ON mission_report(mission_id, row_id) WHERE kind = 'row';
CREATE UNIQUE INDEX mission_report_delegation ON mission_report(mission_id) WHERE kind = 'delegation';
CREATE TABLE mission_snapshot (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('approve','status','export','manual')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  time_created INTEGER NOT NULL
);
CREATE INDEX mission_snapshot_by_mission ON mission_snapshot(mission_id, time_created DESC);
CREATE TABLE mission_event (
  seq INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  row_id TEXT,
  actor TEXT NOT NULL,
  verb TEXT NOT NULL CHECK (verb IN ('create','approve','status','row-add','row-change','row-status','decision','finding','lock','unlock','report','session','export')),
  from_status TEXT, to_status TEXT, decision_id TEXT,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  time_created INTEGER NOT NULL
);
CREATE INDEX mission_event_by_mission ON mission_event(mission_id, seq);

-- Rows belong to a phase of their mission's type, and their kind is allowed in that phase (U20).
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
CREATE TRIGGER mission_type_change BEFORE UPDATE OF type_id, type_version ON mission
WHEN EXISTS (SELECT 1 FROM mission_row WHERE mission_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'MISSION_TYPE_LOCKED'); END;
-- Pinned type definitions and decisions are append-only (the D-06 pattern of the 0001 triggers).
CREATE TRIGGER mission_type_immutable BEFORE UPDATE ON mission_type BEGIN SELECT RAISE(ABORT, 'MISSION_TYPE_IMMUTABLE'); END;
CREATE TRIGGER mission_type_phase_immutable BEFORE UPDATE ON mission_type_phase BEGIN SELECT RAISE(ABORT, 'MISSION_TYPE_IMMUTABLE'); END;
CREATE TRIGGER mission_decision_immutable BEFORE UPDATE ON mission_decision BEGIN SELECT RAISE(ABORT, 'DECISION_IMMUTABLE'); END;
CREATE TRIGGER mission_decision_no_delete BEFORE DELETE ON mission_decision
WHEN EXISTS (SELECT 1 FROM mission WHERE id = OLD.mission_id) BEGIN SELECT RAISE(ABORT, 'DECISION_IMMUTABLE'); END;
CREATE TRIGGER mission_snapshot_immutable BEFORE UPDATE ON mission_snapshot BEGIN SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER mission_event_immutable BEFORE UPDATE ON mission_event BEGIN SELECT RAISE(ABORT, 'EVENT_IMMUTABLE'); END;
-- A closed mission takes no new rows, decisions or findings.
CREATE TRIGGER mission_closed_row BEFORE INSERT ON mission_row
WHEN (SELECT status FROM mission WHERE id = NEW.mission_id) IN ('done','cancelled')
BEGIN SELECT RAISE(ABORT, 'MISSION_CLOSED'); END;
CREATE TRIGGER mission_closed_decision BEFORE INSERT ON mission_decision
WHEN (SELECT status FROM mission WHERE id = NEW.mission_id) IN ('done','cancelled')
BEGIN SELECT RAISE(ABORT, 'MISSION_CLOSED'); END;

-- Search over mission records (row titles and notes, decisions, findings). Report text is already
-- in doc_block_fts (0001), filtered by document.mission_folder.
CREATE VIRTUAL TABLE mission_fts USING fts5(text, mission_id UNINDEXED, ref_kind UNINDEXED, ref_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 0');
CREATE TRIGGER mission_fts_decision AFTER INSERT ON mission_decision BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.text, NEW.mission_id, 'decision', NEW.decision_id); END;
CREATE TRIGGER mission_fts_row_ai AFTER INSERT ON mission_row BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.note, ''), NEW.mission_id, 'row', NEW.row_id); END;
CREATE TRIGGER mission_fts_row_au AFTER UPDATE OF title, note ON mission_row BEGIN
  DELETE FROM mission_fts WHERE mission_id = OLD.mission_id AND ref_kind = 'row' AND ref_id = OLD.row_id;
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.note, ''), NEW.mission_id, 'row', NEW.row_id); END;
CREATE TRIGGER mission_fts_finding_ai AFTER INSERT ON mission_finding BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.evidence, ''), NEW.mission_id, 'finding', NEW.finding_id); END;
CREATE TRIGGER mission_fts_finding_au AFTER UPDATE OF title, evidence ON mission_finding BEGIN
  DELETE FROM mission_fts WHERE mission_id = OLD.mission_id AND ref_kind = 'finding' AND ref_id = OLD.finding_id;
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.title || coalesce(' ' || NEW.evidence, ''), NEW.mission_id, 'finding', NEW.finding_id); END;
`

export const MIGRATION_0003_C57_SQL = `
-- C57 additions (row 119a; decisions C57, C68): what the 1.2.1 interaction panel needs. Same style as above.
-- (a) Decision requests: an open question with options; answering records a decision and releases the rows it blocks.
CREATE TABLE mission_decision_request (
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (request_id GLOB 'D-[0-9]*' AND request_id NOT GLOB 'D-*[^0-9]*' AND length(request_id) BETWEEN 3 AND 7),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  context TEXT CHECK (context IS NULL OR length(context) BETWEEN 1 AND 300),
  options TEXT NOT NULL CHECK (json_valid(options) AND json_type(options) = 'array' AND json_array_length(options) BETWEEN 2 AND 8),
  recommended TEXT,
  blocking_rows TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocking_rows) AND json_type(blocking_rows) = 'array'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','withdrawn')),
  requested_by TEXT NOT NULL,
  answer_option TEXT,
  answered_by TEXT CHECK (answered_by IS NULL OR answered_by IN ('user','controller')),
  answer_decision_id TEXT,
  time_created INTEGER NOT NULL, time_closed INTEGER,
  CHECK ((status = 'answered') = (answer_option IS NOT NULL AND answered_by IS NOT NULL AND answer_decision_id IS NOT NULL)),
  CHECK ((status = 'open') = (time_closed IS NULL)),
  PRIMARY KEY (mission_id, request_id),
  FOREIGN KEY (mission_id, answer_decision_id) REFERENCES mission_decision(mission_id, decision_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX mission_decision_request_status ON mission_decision_request(mission_id, status);
CREATE TRIGGER mission_decision_request_closed BEFORE UPDATE ON mission_decision_request
WHEN OLD.status <> 'open' BEGIN SELECT RAISE(ABORT, 'DECISION_REQUEST_CLOSED'); END;
CREATE TRIGGER mission_closed_request BEFORE INSERT ON mission_decision_request
WHEN (SELECT status FROM mission WHERE id = NEW.mission_id) IN ('done','cancelled')
BEGIN SELECT RAISE(ABORT, 'MISSION_CLOSED'); END;
-- (b) Row checkpoints (n of m): the agent's own progress inside one row, kept apart from mission progress (rows done / total).
CREATE TABLE mission_row_checkpoint (
  seq INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL, row_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 0),
  m INTEGER NOT NULL CHECK (m BETWEEN 1 AND 1000 AND n <= m),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 300),
  actor TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  FOREIGN KEY (mission_id, row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE CASCADE
);
CREATE INDEX mission_row_checkpoint_by_row ON mission_row_checkpoint(mission_id, row_id, seq);
CREATE TRIGGER mission_row_checkpoint_immutable BEFORE UPDATE ON mission_row_checkpoint BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_IMMUTABLE'); END;
-- (c) Message log controller <-> agent <-> owner, and (d) the owner instruction channel (from owner, kind instruction).
-- The store keeps the text; it never executes it.
CREATE TABLE mission_message (
  seq INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
  row_id TEXT,
  from_party TEXT NOT NULL CHECK (from_party IN ('controller','agent','owner')),
  to_party TEXT NOT NULL CHECK (to_party IN ('controller','agent','owner') AND to_party <> from_party),
  actor TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('report','instruction','question')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  time_created INTEGER NOT NULL,
  FOREIGN KEY (mission_id, row_id) REFERENCES mission_row(mission_id, row_id) ON DELETE RESTRICT
);
CREATE INDEX mission_message_by_mission ON mission_message(mission_id, seq);
CREATE TRIGGER mission_message_immutable BEFORE UPDATE ON mission_message BEGIN SELECT RAISE(ABORT, 'MESSAGE_IMMUTABLE'); END;
CREATE TRIGGER mission_closed_message BEFORE INSERT ON mission_message
WHEN (SELECT status FROM mission WHERE id = NEW.mission_id) IN ('done','cancelled')
BEGIN SELECT RAISE(ABORT, 'MISSION_CLOSED'); END;
CREATE TRIGGER mission_fts_request AFTER INSERT ON mission_decision_request BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.question || coalesce(' ' || NEW.context, ''), NEW.mission_id, 'request', NEW.request_id); END;
CREATE TRIGGER mission_fts_message AFTER INSERT ON mission_message BEGIN
  INSERT INTO mission_fts(text, mission_id, ref_kind, ref_id) VALUES (NEW.text, NEW.mission_id, 'message', CAST(NEW.seq AS TEXT)); END;
`

export const MIGRATION_0003_SQL = MIGRATION_0003_SPEC_SQL + MIGRATION_0003_C57_SQL
