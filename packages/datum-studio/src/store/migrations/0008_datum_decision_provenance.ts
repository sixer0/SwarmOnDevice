/**
 * Migration 0008 (`20261114000000_datum_decision_provenance`), Swarm 1.2.8 row 45b (AC-SEC05, SR8-05; register N8-461;
 * decision C14).
 *
 * Answer provenance. `studio_mission_answer_decision {by: "user"}` can be sent by any MCP session; until now the store
 * kept only `answered_by`. The host now records, for every answer it writes:
 * - `answered_via`: the answering MCP session's agent id (`X-Studio-Agent`, 1-40 characters);
 * - `answered_attested`: 1 when that session presented the per-launch Mission Control key at initialize
 *   (`x-swarm-mission-control-key`, N8-459), else 0.
 * Both stay NULL for answers recorded before 1.2.8 and for answers written by trusted store code without a session;
 * a NULL answer shows no label (SR8-05 display rule).
 *
 * Request topic and tidy proposal (1.2.8 row 45, N8-146/N8-148) move from the first stored option (key `$request`,
 * row 45's stop-gap: the 0003 CHECK keeps `options` a 2-8 item array) to their own columns `topic` and `proposal`.
 * The backfill moves any `$request` value a 1.2.8 development store already holds; no released build wrote one. The
 * 0003 trigger `mission_decision_request_closed` refuses every UPDATE of a closed request, so the backfill drops it,
 * moves the values and creates it again with the same text, all inside this migration's transaction.
 *
 * Additive: four nullable columns on mission_decision_request; no table rebuild. Undo below 1.2.8 after this ran makes
 * Studio refuse the store (STORE_SCHEMA_NEWER) until 1.2.8 is reinstalled (C14, release note RN-13).
 * Do not edit: a change is a new migration.
 */
export const MIGRATION_0008_ID = "20261114000000_datum_decision_provenance"

export const MIGRATION_0008_SQL = `-- datum-studio store, migration 20261114000000_datum_decision_provenance (1.2.8 row 45b, SR8-05). Additive only.
ALTER TABLE mission_decision_request ADD COLUMN answered_via TEXT CHECK (answered_via IS NULL OR (status = 'answered' AND length(answered_via) BETWEEN 1 AND 40));
ALTER TABLE mission_decision_request ADD COLUMN answered_attested INTEGER CHECK (answered_attested IS NULL OR (answered_attested IN (0, 1) AND answered_via IS NOT NULL));
ALTER TABLE mission_decision_request ADD COLUMN topic TEXT CHECK (topic IS NULL OR topic IN ('project-placement', 'project-tidy'));
ALTER TABLE mission_decision_request ADD COLUMN proposal TEXT CHECK (proposal IS NULL OR (topic = 'project-tidy' AND json_valid(proposal) AND json_type(proposal) = 'array' AND json_array_length(proposal) BETWEEN 1 AND 200));
DROP TRIGGER mission_decision_request_closed;
UPDATE mission_decision_request
SET topic = json_extract(options, '$[0]."$request".topic'),
    proposal = json_extract(options, '$[0]."$request".proposal'),
    options = json_remove(options, '$[0]."$request"')
WHERE json_type(options, '$[0]."$request"') = 'object';
CREATE TRIGGER mission_decision_request_closed BEFORE UPDATE ON mission_decision_request
WHEN OLD.status <> 'open' BEGIN SELECT RAISE(ABORT, 'DECISION_REQUEST_CLOSED'); END;
`
