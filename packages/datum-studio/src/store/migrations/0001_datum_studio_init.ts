/**
 * Migration 0001 (`20261106000000_datum_studio_init`), copied verbatim from the row 8 probe DDL
 * `/private/tmp/claude-501/row08/ddl/0001_datum_studio_init.sql` (spec masterplan/01_specs_studio_store.md §3, proven §2.4).
 * Source sha256: 5c916bb613d19d9e09cd5e3fda5787f0dfa42478daf5870d5003ee9cf0301fa3. Do not edit: a change is a new migration (0002 is reserved for row 64, 0003 for row 119).
 */
export const MIGRATION_0001_SQL = `-- datum-studio store, migration 20261106000000_datum_studio_init (row 08 spec, applied by row 30)
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE template (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  origin TEXT NOT NULL CHECK (origin IN ('builtin','user')),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DOCUMENT','CHART','DIAGRAM','IMAGE','HTML')),
  description TEXT,
  is_canonical INTEGER NOT NULL DEFAULT 0 CHECK (is_canonical IN (0,1)),
  is_preset INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0,1)),
  contract_kind TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  latest_version_no INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  CHECK ((origin = 'user') = (slug GLOB 'user-*')),
  CHECK (origin = 'user' OR archived = 0)
);
CREATE INDEX template_kind_idx ON template(kind);
CREATE INDEX template_archived_idx ON template(archived);
CREATE INDEX template_contract_kind_idx ON template(contract_kind);
CREATE TABLE template_version (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  base_version_id TEXT REFERENCES template_version(id) ON DELETE RESTRICT,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64),
  overrides TEXT NOT NULL CHECK (json_valid(overrides)),
  resolved_params TEXT NOT NULL CHECK (json_valid(resolved_params)),
  params_sha256 TEXT NOT NULL,
  role_formats TEXT NOT NULL CHECK (json_valid(role_formats)),
  section_plan TEXT NOT NULL CHECK (json_valid(section_plan)),
  assets TEXT NOT NULL CHECK (json_valid(assets)),
  provenance TEXT NOT NULL CHECK (json_valid(provenance)),
  skeleton TEXT CHECK (skeleton IS NULL OR json_valid(skeleton)),
  skeleton_sha256 TEXT,
  change_note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE (template_id, version_no)
);
CREATE INDEX template_version_base_idx ON template_version(base_version_id);
CREATE TRIGGER template_version_immutable BEFORE UPDATE ON template_version
BEGIN SELECT RAISE(ABORT, 'TEMPLATE_VERSION_IMMUTABLE'); END;
CREATE TRIGGER template_version_no_delete BEFORE DELETE ON template_version
BEGIN SELECT RAISE(ABORT, 'TEMPLATE_VERSION_IMMUTABLE'); END;
CREATE TABLE document (
  id TEXT PRIMARY KEY,
  doc_number TEXT NOT NULL UNIQUE,
  doc_number_safe TEXT NOT NULL,
  number_source TEXT NOT NULL CHECK (number_source IN ('AGENT','SEQUENCE')),
  title TEXT NOT NULL,
  type_code TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'ID',
  classification TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('NOTA','TERBIT','SERAH')),
  template_id TEXT NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  current_revision_no INTEGER NOT NULL DEFAULT 1,
  mission_folder TEXT,
  mission_doc_key TEXT,
  agent_request_id TEXT,
  hermes_task_id TEXT,
  created_by TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  completeness TEXT NOT NULL DEFAULT 'COMPLETE' CHECK (completeness IN ('INCOMPLETE','COMPLETE')),
  contract_kind TEXT,
  contract_status TEXT,
  contract_owner TEXT,
  contract_task_ref TEXT,
  contract_due_on TEXT CHECK (contract_due_on IS NULL OR date(contract_due_on) = contract_due_on),
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  UNIQUE (mission_folder, mission_doc_key)
);
CREATE INDEX document_mission_idx ON document(mission_folder);
CREATE INDEX document_template_idx ON document(template_id);
CREATE INDEX document_doc_number_safe_idx ON document(doc_number_safe);
CREATE INDEX document_contract_idx ON document(contract_kind, contract_status);
CREATE INDEX document_contract_owner_idx ON document(contract_owner);
CREATE INDEX document_contract_task_ref_idx ON document(contract_task_ref);
CREATE INDEX document_contract_due_idx ON document(contract_due_on);
CREATE INDEX document_updated_idx ON document(time_updated DESC, id DESC);
CREATE TABLE document_card (
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL CHECK (card_id GLOB 't_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  PRIMARY KEY (document_id, card_id)
) WITHOUT ROWID;
CREATE INDEX document_card_card_idx ON document_card(card_id);
CREATE TABLE revision (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  parent_revision_no INTEGER,
  template_version_id TEXT NOT NULL REFERENCES template_version(id) ON DELETE RESTRICT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  snapshot_sha256 TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  doc_rev TEXT NOT NULL,
  change_what TEXT NOT NULL,
  change_why TEXT NOT NULL,
  change_impact TEXT NOT NULL,
  changed_addresses TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_addresses)),
  release_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (release_status IN ('PENDING','PASS','FAIL','NOT_RUN')),
  lint_report TEXT CHECK (lint_report IS NULL OR json_valid(lint_report)),
  created_by TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  schema_id TEXT NOT NULL DEFAULT 'studio.doc/v1',
  structure_sha256 TEXT,
  completeness TEXT NOT NULL DEFAULT 'COMPLETE' CHECK (completeness IN ('INCOMPLETE','COMPLETE')),
  completeness_report TEXT CHECK (completeness_report IS NULL OR json_valid(completeness_report)),
  change_scope TEXT,
  UNIQUE (document_id, revision_no)
);
CREATE INDEX revision_template_version_idx ON revision(template_version_id);
CREATE TRIGGER revision_immutable BEFORE UPDATE OF id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, changed_addresses, created_by, time_created, schema_id, structure_sha256, completeness, completeness_report, change_scope ON revision
BEGIN SELECT RAISE(ABORT, 'REVISION_IMMUTABLE'); END;
CREATE TABLE block (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  address TEXT NOT NULL,
  artifact_label TEXT,
  ordinal INTEGER NOT NULL,
  chapter_key TEXT NOT NULL,
  section_no INTEGER,
  para_no INTEGER,
  type TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  text_plain TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  UNIQUE (revision_id, address),
  UNIQUE (revision_id, ordinal)
);
CREATE INDEX block_revision_block_idx ON block(revision_id, block_id);
CREATE TABLE asset (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
  bytes INTEGER NOT NULL,
  width_px INTEGER NOT NULL,
  height_px INTEGER NOT NULL,
  rel_path TEXT NOT NULL UNIQUE CHECK (rel_path GLOB 'assets/*'),
  mission_folder TEXT,
  created_by TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
CREATE INDEX asset_mission_idx ON asset(mission_folder);
CREATE TABLE doc_identity (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  pid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHAPTER','SUBSECTION','BLOCK')),
  created_revision_no INTEGER NOT NULL,
  retired_revision_no INTEGER,
  created_by TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE (document_id, pid)
);
CREATE INDEX doc_identity_kind_idx ON doc_identity(document_id, kind);
CREATE TABLE doc_section (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  template_slot_key TEXT,
  slot_key TEXT NOT NULL,
  section_type_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  filled INTEGER NOT NULL CHECK (filled IN (0,1)),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  payload_sha256 TEXT NOT NULL,
  last_filled_by TEXT,
  last_filled_at INTEGER,
  last_filled_revision_no INTEGER,
  UNIQUE (revision_id, slot_key),
  UNIQUE (revision_id, position)
);
CREATE TABLE doc_chapter (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  doc_section_id TEXT NOT NULL REFERENCES doc_section(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES doc_identity(id) ON DELETE NO ACTION,
  chapter_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  part_key TEXT,
  title TEXT NOT NULL CHECK (json_valid(title)),
  short_title TEXT,
  content_sha256 TEXT NOT NULL,
  last_filled_by TEXT,
  last_filled_at INTEGER,
  last_filled_revision_no INTEGER,
  UNIQUE (revision_id, chapter_key),
  UNIQUE (doc_section_id, position)
);
CREATE INDEX doc_chapter_identity_idx ON doc_chapter(identity_id);
CREATE TABLE doc_subsection (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES doc_chapter(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES doc_identity(id) ON DELETE NO ACTION,
  section_no INTEGER NOT NULL CHECK (section_no >= 0),
  title TEXT CHECK (title IS NULL OR json_valid(title)),
  content_sha256 TEXT NOT NULL,
  UNIQUE (chapter_id, section_no)
);
CREATE TABLE doc_block (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  doc_section_id TEXT NOT NULL REFERENCES doc_section(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES doc_chapter(id) ON DELETE CASCADE,
  subsection_id TEXT REFERENCES doc_subsection(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES doc_identity(id) ON DELETE NO ACTION,
  pid TEXT NOT NULL,
  address TEXT,
  artifact_label TEXT,
  ordinal INTEGER NOT NULL,
  para_no INTEGER,
  type TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  text_plain TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  asset_id TEXT REFERENCES asset(id) ON DELETE RESTRICT,
  UNIQUE (revision_id, ordinal),
  UNIQUE (revision_id, pid),
  UNIQUE (revision_id, address)
);
CREATE INDEX doc_block_subsection_idx ON doc_block(subsection_id, para_no);
CREATE INDEX doc_block_revision_type_idx ON doc_block(revision_id, type);
CREATE INDEX doc_block_asset_idx ON doc_block(asset_id);
CREATE VIRTUAL TABLE doc_block_fts USING fts5(text_plain, content='doc_block', content_rowid='seq', tokenize='unicode61 remove_diacritics 0');
CREATE TRIGGER doc_block_fts_ai AFTER INSERT ON doc_block BEGIN
  INSERT INTO doc_block_fts(rowid, text_plain) VALUES (new.seq, substr(new.text_plain, 1, 100000));
END;
CREATE TRIGGER doc_block_fts_ad AFTER DELETE ON doc_block BEGIN
  INSERT INTO doc_block_fts(doc_block_fts, rowid, text_plain) VALUES ('delete', old.seq, substr(old.text_plain, 1, 100000));
END;
CREATE TRIGGER doc_block_immutable BEFORE UPDATE ON doc_block BEGIN SELECT RAISE(ABORT, 'DOC_BLOCK_IMMUTABLE'); END;
CREATE TABLE contract_record (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE REFERENCES revision(id) ON DELETE CASCADE,
  doc_section_id TEXT NOT NULL UNIQUE REFERENCES doc_section(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  contract_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  owner TEXT,
  initiator TEXT,
  task_ref TEXT,
  reported_at INTEGER NOT NULL,
  due_on TEXT CHECK (due_on IS NULL OR date(due_on) = due_on),
  phase_from TEXT,
  phase_to TEXT,
  card_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(card_ids)),
  item_count INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE (document_id, revision_no)
);
CREATE INDEX contract_record_kind_status_idx ON contract_record(contract_kind, status);
CREATE TABLE contract_item (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES contract_record(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  pid TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  phase TEXT,
  due_on TEXT CHECK (due_on IS NULL OR date(due_on) = due_on),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  title_plain TEXT NOT NULL,
  UNIQUE (record_id, item_key),
  UNIQUE (record_id, position)
);
CREATE INDEX contract_item_key_idx ON contract_item(item_key);
CREATE INDEX contract_item_doc_rev_idx ON contract_item(document_id, revision_no);
CREATE TABLE doc_ref (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES contract_record(id) ON DELETE CASCADE,
  from_document_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  position INTEGER NOT NULL,
  rel TEXT NOT NULL,
  target_document_id TEXT NOT NULL,
  target_pid TEXT,
  target_revision_no INTEGER,
  UNIQUE (record_id, position)
);
CREATE INDEX doc_ref_target_idx ON doc_ref(target_document_id, target_pid);
CREATE INDEX doc_ref_from_idx ON doc_ref(from_document_id, revision_no);
CREATE TABLE render_job (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES document(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES revision(id) ON DELETE CASCADE,
  formats TEXT NOT NULL CHECK (json_valid(formats)),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  error_code TEXT,
  error_message TEXT,
  engine TEXT CHECK (engine IS NULL OR json_valid(engine)),
  requested_by TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'DOCUMENT' CHECK (scope_kind IN ('DOCUMENT','CHAPTER','SLOT')),
  scope_key TEXT,
  time_queued INTEGER NOT NULL,
  time_started INTEGER,
  time_finished INTEGER,
  duration_ms INTEGER
);
CREATE INDEX render_job_status_idx ON render_job(status);
CREATE INDEX render_job_document_idx ON render_job(document_id);
CREATE TABLE output_file (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document','preview')),
  document_id TEXT REFERENCES document(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES revision(id) ON DELETE CASCADE,
  template_version_id TEXT REFERENCES template_version(id) ON DELETE RESTRICT,
  render_job_id TEXT REFERENCES render_job(id) ON DELETE SET NULL,
  format TEXT NOT NULL CHECK (format IN ('DOCX','PDF','HTML','SVG','PNG')),
  role TEXT NOT NULL CHECK (role IN ('PRIMARY','FIGURE')),
  figure_label TEXT,
  rel_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  mime TEXT NOT NULL,
  lint_verdict TEXT NOT NULL DEFAULT 'PENDING' CHECK (lint_verdict IN ('PENDING','PASS','FAIL','NOT_RUN')),
  scope_kind TEXT NOT NULL DEFAULT 'DOCUMENT' CHECK (scope_kind IN ('DOCUMENT','CHAPTER','SLOT')),
  scope_key TEXT,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0,1)),
  time_created INTEGER NOT NULL,
  CHECK ((kind = 'document' AND revision_id IS NOT NULL AND document_id IS NOT NULL) OR (kind = 'preview' AND revision_id IS NULL AND document_id IS NULL))
);
CREATE INDEX output_file_doc_rev_idx ON output_file(document_id, revision_id);
CREATE INDEX output_file_sha_idx ON output_file(sha256);
`
