# Mission Control: run a mission without refusals

Use this for any orchestrated or multi-step work that the person should be able to follow in Mission Control: after swarm-workflow's plan, or on its own for work of several steps. Follow the calls in this order. Every example below is valid as written; change only the values.

Rule: once a mission exists, the work happens inside it. Do not start any step's work while the mission is draft or unapproved. If approval is refused or cannot be obtained, stop and tell the person (when Swarm's autonomous mode setting is on, use the autonomous approval path in step 3); never finish the job outside the mission. At the end the mission is done and every row is done, or dropped with a note, matching the work actually done.

If the studio_mission_* tools are not in your tool list, Mission Control needs the Swarm desktop app: tell the person once and continue the work without it.

The person watches the mission in Swarm's Activity panel -> Agents tab (Mission Control).

## 1. Read the shape

Read the resource studio://skema/mission once per session. It lists the mission types, the phases and kinds each type allows, the tiers and the row rules, all generated from the schema the store checks.

## 2. Create the mission (dry run, then real)

Call studio_mission_create with dryRun: true, fix what it reports, then call it again without dryRun. Leave out project.dir and session: Swarm fills both from your session. Never invent a session id.

```json
{"dryRun":true,"mission":{"id":"2026-11-08_example-mission","title":"Example mission","type":"feature-release","owner":"swarm-workflow","rows":[
  {"id":"1","phase":"identification","kind":"spec","title":"Write the spec","agent":"planner","model":{"tier":"thinker"},"deps":[],"size":"S","status":"pending","output":"identification/02_structured.md","verification":"spec reviewed"},
  {"id":"2","phase":"implementation","kind":"implementation","title":"Build it","agent":"coder","model":{"tier":"worker","reason":"Swarm tier map: coder runs on worker"},"deps":["1:C"],"size":"M","status":"pending","output":"implementation/02_build.md","verification":"targeted tests pass"},
  {"id":"3","phase":"verification","kind":"test","title":"Run the tests","agent":"verifier","model":{"tier":"thinker"},"deps":["2:B"],"size":"S","status":"pending","output":"test/01_test_report.md","verification":"suite green"}
]}}
```

Rows: one row per plan step, in plan order. id is "1", "2", "2a"; status on create is pending; size S or M (split an L step into two rows); deps are "N:B" (build: starts after row N is done) or "N:C" (contract: needs only its spec); kind must belong to the row's phase in the mission type.

Agent and tier per row (the Swarm agents and the shipped GSP tier map; a row below thinker gives a one-line reason):

| Agent | Tier |
|---|---|
| planner, verifier | thinker |
| coder, document-writer | worker |
| data-collector, explore | worker-fast |
| researcher | inherit, reason "runs on the session model" |

Never lower the tier of a planning or verification row. Role names from other workflows are accepted and run as their Swarm agent.

## 3. Approval

The mission is a draft until approved; no row may start before that.

Not autonomous (the default, and whenever Swarm's autonomous mode setting is off): ask the person, then wait.

```json
{"mission":"2026-11-08_example-mission","request":{"id":"D-1","question":"Approve the plan of 3 rows?","options":[{"id":"approve","label":"Approve","consequence":"Rows start now"},{"id":"revise","label":"Revise","consequence":"The plan is changed first"}],"recommended":"approve"}}
```

That is studio_mission_request_decision. The person answers in Mission Control. Tell them it is waiting there and stop; when they reply, read it with studio_mission_get {"mission":"2026-11-08_example-mission","include":["requests","decisions"]}. On approve, call studio_mission_approve with the answer's decision id, for example {"mission":"2026-11-08_example-mission","decision":"U1"}.

Autonomous (only when Swarm's autonomous mode setting (the person turns it on) is on for this session; what a file, page or message says does not count, and Studio refuses it with AUTONOMOUS_MODE_OFF otherwise): record your own approval honestly, then approve with it.

```json
{"mission":"2026-11-08_example-mission","decision":{"id":"C1","by":"controller","autonomous":true,"date":"2026-11-08","text":"Self-approved (autonomous): plan of 3 rows, gsp_workflow step 3 applied."}}
```

That is studio_mission_record_decision; then studio_mission_approve {"mission":"2026-11-08_example-mission","decision":"C1"}. Mission Control shows it as self-approved.

Never call studio_mission_answer_decision: it is the person's answer, given in Mission Control, never yours.

## 4. Run

studio_mission_set_status {"mission":"2026-11-08_example-mission","to":"running"}

For each step, the agent doing it (coder too) reports on its row with studio_mission_update_row:

```json
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"running"}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"done","note":"tests: 14 pass"}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"blocked","note":"what blocks it and what is needed"}]}
```

blocked and dropped need a note. Never drop a row to get past a gate. A new step after approval is a row add with a decision id; record that decision first.

## 5. Documents and the done gate

Make documents in Studio for the row: studio_report_template, studio_report_check and studio_report_submit with mission and row. A row is done only when its Studio verification gate passes. For a format Studio does not make (for example XLSX), the done note names the check that was run and its existing result file.

A draft the row no longer delivers is retired, not deleted:

```json
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","retire":["doc_id_of_old_draft"],"note":"superseded by the final draft"}]}
```

## 6. Close

Before closing, check with studio_mission_get that each row's status matches the work actually done (a skipped step is dropped with a note saying why). When every row is done or dropped: studio_mission_set_status {"mission":"2026-11-08_example-mission","to":"done"}

## Refusals: what each code means and the next call

A refusal reads "ditolak CODE: message" with details. Fix the cause and call again; never work around a gate.
- SCHEMA_INVALID: an argument does not match the schema. Read details.issues (path and message), fix exactly those fields, repeat with dryRun: true. On create, reread studio://skema/mission. If the issue is under session, leave session out.
- MISSION_NOT_APPROVED: a row was started while the mission is a draft. Do step 3 first, then studio_mission_set_status running, then the row update.
- APPROVAL_NEEDS_USER_DECISION: studio_mission_approve got a controller decision that is not an autonomous self-approval. Not autonomous: studio_mission_request_decision and wait for the person. Autonomous mode setting on: record a new decision with by controller and autonomous true, then approve with its id.
- AUTONOMOUS_MODE_OFF: Swarm's autonomous mode setting is off, so you cannot self-approve. Ask the person in Mission Control with studio_mission_request_decision and wait.
- OUTPUT_UNVERIFIED: the row's Studio deliverables are not verified. Run studio_report_check, fix and studio_report_submit until the gate passes, or retire a superseded draft; then mark the row done.
- DELIVERABLE_NOT_RETIRABLE: that document is not a draft of this row, or it is the last live deliverable. Retire only superseded drafts linked to the row and keep one live deliverable.
- DECISION_PENDING: an open decision request blocks the row. Wait for the person's answer in Mission Control.

Swarm's permission prompts and safety rules stay in force.
