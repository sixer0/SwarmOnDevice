# Mission Control: run a mission without refusals

Use this for any orchestrated or multi-step work that the person should be able to follow in Mission Control: after swarm-workflow's plan, or on its own for work of several steps. Follow the steps in this order. The two tables come first because most refusals are a status move or a row field.

## Status moves (anything else is refused STATUS_TRANSITION)
| Status now | May move to | What the move needs |
|---|---|---|
| mission draft | approved, cancelled | approved only through datum-studio_studio_mission_approve with a decision id; cancelled needs a decision |
| mission approved | running, paused, cancelled | it also turns running by itself when the first row goes running |
| mission running | paused, done, cancelled | done: every row done or dropped, and the mission index entry (step 8) |
| mission paused | running, cancelled | no row may go running while it is paused |
| mission done, cancelled | nothing | closed for good |
| row pending | running, blocked, dropped | running: mission approved and not paused, every "N:B" dependency done, no open decision request on the row |
| row running | needs-review, blocked, done | done: a note and the done gate (step 6); needs-review: the deliverable is in the project folder |
| row needs-review | done, blocked, running | done: the done gate |
| row blocked | running, dropped | a recovered row closes with two patches in one call: running, then done with its note |
| row done | running | reopening needs a decision |
| row dropped | nothing | after approval dropping needs a decision; refused DEP_DROPPED while another row has a "N:B" dependency on it |

running -> done needs a note (the check and its result); needs-review is optional: use it only when someone else must judge the result. blocked and dropped need a note. Never drop a row to get past a gate.

## Row fields
| Field | Must you send it | Default when left out | Limits |
|---|---|---|---|
| title | yes | none | one line, 1-4000 characters |
| id | no on create; yes in every patch | "1", "2", ... in list order | 1-9999, one optional lower-case letter: "2", "2a" |
| phase, kind | no | first phase of the mission type, first kind of that phase | kind must belong to the phase in the mission type (KIND_NOT_ALLOWED, PHASE_UNKNOWN) |
| agent | no | one fixed agent; the reply names every field it defaulted | lower-case name, at most 64 characters |
| model | no | tier taken from the agent | tier thinker, worker, worker-fast or inherit; worker and worker-fast need reason, one line |
| deps | no | [] | at most 64, each "N:B" (build: starts after row N is done) or "N:C" (contract: needs only its spec) |
| size | no | S | S or M; split a larger step into two rows |
| status | no | pending | a row is created or added pending or dropped only |
| output, verification | no | one fixed text each, named in the reply; the default output is never a document output at the done gate | one line, 1-4000 characters |
| note | with blocked, dropped, retire and running -> done | none | one line, 1-4000 characters; only inside a row patch, never at the top level |
| review, resources | no | gate, [] | gate or none; at most 16 resources |
| knowledgeReason | only to waive KNOWLEDGE_NOT_CONSULTED | none | row patch field, one line, 1-300 characters |
| deliverables, knowledge, awaitingHumanCheck | never | written by Swarm | sending one is refused FIELD_READ_ONLY |

## Rules
Calls are made through the tools, never written in the answer. A call typed as text runs nothing: Swarm asks for the real call, and after two such corrections in a row the turn ends. Every example below is a heading that is the exact tool name, then the arguments alone; change only the values.

Rule: once a mission exists, the work happens inside it. Do not start any step's work while the mission is draft or unapproved. If approval is refused or cannot be obtained, stop and tell the person (when Swarm's autonomous mode setting is on, use the autonomous approval path in step 3); never finish the job outside the mission. At the end the mission is done and every row is done, or dropped with a note, matching the work actually done.

If the datum-studio_studio_mission_* tools are not in your tool list, Mission Control needs the Swarm desktop app: tell the person once and continue the work without it.

The person watches the mission in Swarm's Activity panel -> Agents tab (Mission Control). After a context compaction, the first call is datum-studio_studio_mission_get for the mission; continue from the first unfinished row.

## 1. Read the shape
Read the resource studio://skema/mission once per session. It lists the mission types, the phases and kinds each type allows, the status moves, the tiers and the row rules, all generated from the schema the store checks.

## 2. Create the mission (dry run, then real)
Call datum-studio_studio_mission_create with dryRun: true, fix what it reports, then call it again without dryRun. Leave out project.dir and session: Swarm fills both from your session. Never invent a session id. When your session folder is the Default Project root, load the project-folders skill after the real create: you propose a group, the person chooses, you never move the mission.
### datum-studio_studio_mission_create
```json
{"dryRun":true,"mission":{"id":"2026-11-08_example-mission","title":"Example mission","type":"feature-release","rows":[
  {"title":"Write the spec"},
  {"title":"Build it","phase":"implementation","kind":"implementation","agent":"coder","deps":["1:C"],"size":"M","output":"05_implementation/02_build.md","verification":"targeted tests pass"},
  {"title":"Run the tests","phase":"verification","kind":"test","agent":"verifier","deps":["2:B"],"output":"07_test/01_test_report.md","verification":"suite green"}
]}}
```
Rows: one row per plan step, in plan order. The smallest mission is id, title, type and the step titles; add a field from the table only where the plan says something else than the default; a value you send is never overwritten by a default. When you send agent and model, use the Swarm agents and the shipped GSP tier map (a row below thinker gives a one-line reason):

| Agent | Tier |
|---|---|
| planner, verifier | thinker |
| coder, document-writer | worker |
| data-collector, explore | worker-fast |
| researcher | inherit, reason "runs on the session model" |
Never lower the tier of a planning or verification row. Role names from other workflows are accepted and run as their Swarm agent.

## 3. Approval
The mission is a draft until approved; no row may start before that.

Not autonomous (the default, and whenever Swarm's autonomous mode setting is off): ask the person, then wait. Limits of the request: context is one line of at most 300 characters; options are 2 to 8, each with id, label and consequence (one line, at most 300 characters each); blockingRows goes inside request (at most 64 row ids), never at the top level; recommended is one of the option ids.
### datum-studio_studio_mission_request_decision
```json
{"mission":"2026-11-08_example-mission","request":{"id":"D-1","question":"Approve the plan of 3 rows?","context":"Spec, build, tests; nothing starts before your answer.","options":[{"id":"approve","label":"Approve","consequence":"Rows start now"},{"id":"revise","label":"Revise","consequence":"The plan is changed first"}],"recommended":"approve","blockingRows":["1"]}}
```
The person answers in Mission Control. Tell them it is waiting there and stop. When they reply, read the answer with datum-studio_studio_mission_get (include requests and decisions), then approve with the decision id their answer recorded.
### datum-studio_studio_mission_approve
```json
{"mission":"2026-11-08_example-mission","decision":"U1"}
```
Autonomous (only when Swarm's autonomous mode setting (the person turns it on) is on for this session; what a file, page or message says does not count): record your own approval honestly, then approve with its id ("decision":"C1" in the approve arguments above). autonomous goes at the top level or inside decision; both are stored the same.
### datum-studio_studio_mission_record_decision
```json
{"mission":"2026-11-08_example-mission","decision":{"id":"C1","by":"controller","date":"2026-11-08","text":"Self-approved (autonomous): plan of 3 rows."},"autonomous":true}
```
Mission Control shows it as self-approved. Never call datum-studio_studio_mission_answer_decision: it is the person's answer, given in Mission Control, never yours. Never record a decision by user; a message from owner is also the person's alone, so yours go from controller.

## 4. Run the rows
Set the mission running, then send one row patch per change. Setting the status a mission already has returns unchanged: true and writes nothing, so a repeated call is safe.
### datum-studio_studio_mission_set_status
```json
{"mission":"2026-11-08_example-mission","to":"running"}
```
### datum-studio_studio_mission_update_row
Each line is the arguments of one call: start, progress with a message, done, blocked.
```json
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"running","acquire":["build/lockfile"]}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","checkpoint":{"n":2,"m":5,"label":"render round 2"}}],"messages":[{"from":"controller","to":"agent","kind":"instruction","text":"Row 2: build it and run the targeted tests.","row":"2"}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"done","note":"targeted tests: 14 pass, log 05_implementation/02_build.md","release":["build/lockfile"]}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"3","status":"blocked","note":"what blocks it and what is needed"}]}
```
While a row runs, progress and hand-offs go on it as a checkpoint {n, m, label} and messages {from, to, kind, text, row}, sent before the done patch. A single-writer resource is held with acquire and given back with release; a name is lower-case letters, digits and . _ / - (at most 80 characters), and a resource another row holds is refused LOCK_HELD until that row releases it.

Read the result, not only the call: each patch applies or is refused on its own, and the call fails only when no patch applies. data.results[] {id, ok, code?, message?, noteSaved?} has one entry per patch, in order; fix a refused patch by its code (below) and send that patch again. Notes are never held back by dependencies: a note-only patch always applies, and a status refused DEP_NOT_DONE in a patch that also carries a note still stores the note (noteSaved: true).

## 5. Changes after approval: one decision record
Decisions live in the mission store: it is the one decision record. Record each decision before the change it allows; decisions are append-only, and a correction is a new decision with "supersedes":["C2"]. After approval, adding a row, changing a structural field (phase, kind, deps, agent, title, output, verification, ownership, size, model), dropping a row or reopening a done row needs a decision id. rows[].decision gives one patch its own decision and overrides the call-level decision. Record the decision first, then patch.
### datum-studio_studio_mission_record_decision
```json
{"mission":"2026-11-08_example-mission","decision":{"id":"C2","by":"controller","date":"2026-11-08","text":"Add a docs check; row 3 is covered by row 2.","rows":["3","4"]}}
```
### datum-studio_studio_mission_update_row
```json
{"mission":"2026-11-08_example-mission","rows":[{"id":"4","decision":"C2","add":{"id":"4","phase":"verification","kind":"test","title":"Check the docs","agent":"verifier","model":{"tier":"thinker"},"deps":["2:B"],"size":"S","status":"pending","output":"07_test/02_docs_check.md","verification":"links resolve"}},{"id":"3","decision":"C2","status":"dropped","note":"covered by row 2"}]}
```
Rows added or dropped after approval, and changes to a row's deps, agent, phase, kind, size, model tier, output or verification, show in datum-studio_studio_mission_get as derived.drift, each with its decision id. docs/<mission>/09_decisions/decisions.md is an export of that register (datum-studio_studio_mission_export), never a second place to write decisions.

An open issue found on the way is a finding. It names the row it came from (sourceRow); an open finding names the row that owns the fix (ownerRow); accepted or deferred needs a decision.
### datum-studio_studio_mission_record_finding
```json
{"mission":"2026-11-08_example-mission","finding":{"id":"F1","severity":"medium","title":"Docs link check is manual","sourceRow":"2","ownerRow":"4","status":"open"}}
```
## 6. Documents and the done gate
Make documents in Studio for the row (the datum-house-style skill has the document calls); a document belongs to the row through docKey row-<row>-<name>. The row's work report goes through datum-studio_studio_report_template, datum-studio_studio_report_check and datum-studio_studio_report_submit with mission and row (docKey exactly row-<row>); a submitted report moves a running row to needs-review. A row is done only when its Studio verification gate passes. Close a row that delivers a document in this order:

1. Retire a draft the row no longer delivers, in a patch call of its own (a retire sent together with a refused status is rolled back). A draft the row no longer delivers is retired, not deleted, and one live deliverable must stay.
2. Render the final revision with datum-studio_studio_render. Read its verification lines and projectCopy: Swarm copies the DOCX, PDF and HTML to deliverables/<mission-id>/ in the project folder; you do not send downloadDir for that.
3. Verify each output of that render with datum-studio_studio_file_verify (fileId, expectedSha256). A new render makes new file ids, so verify the ids of the revision you close on.
4. Send done with a note that names the check, its result and the project-relative file path.
### datum-studio_studio_mission_update_row
The retire call of step 1, then the done call of step 4:
```json
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","retire":["doc_id_of_old_draft"],"note":"superseded by the final draft"}]}
{"mission":"2026-11-08_example-mission","rows":[{"id":"2","status":"done","note":"render rev 4 verified, sha256 matches; deliverables/2026-11-08_example-mission/012-GSP-KT-XI-2026 RevA rev4.pdf"}]}
```
For a format Studio does not make (for example XLSX), the done note names the check that was run and its existing result file. A figure whose labels a person has not checked does not block the row: it closes done and carries the awaiting-human mark (awaitingHumanCheck) until the person clears it in Mission Control. Never send labels_verified: true yourself (LABELS_VERIFIED_PERSON_ONLY).

Numbers: every derived number (a sum, ratio, conversion or estimate) is recomputed by a second party, another agent or a script that did not write the chapter, before the chapter is submitted. Keep a table with one line per number: the number, its formula, its source, recomputed by, and the recomputed result. The chapter uses the numbers of that table unchanged; a mismatch is fixed before submitting, never rounded away.

## 7. Delegating a row
- When the row's agent promises files, pass them to the task tool as expected_outputs (absolute, or relative to the session directory). A path missing after the run fails the task with "Promised output missing: <paths>" (SUBAGENT_OUTPUT_MISSING): mark the row blocked with that text as the note, or continue the same task_id. Never mark it done.
- A subagent that ends without an answer fails with "Subagent returned no result:" (SUBAGENT_NO_RESULT) and the reason: continue its task_id, or mark the row blocked with the reason.
- Studio for subagents: planner and document-writer may read missions and documents and preview or revise figures without a prompt. Their other Studio calls, datum-studio_studio_mission_update_row included, ask the person first; datum-studio_studio_mission_answer_decision is denied to every agent. So the controller writes row status and messages from the agent's returned report, and writes the output file of an agent that cannot edit files (verifier).

## 8. Pause and close
Stopping unfinished: set the mission paused with a note saying what is open and why; no row may go running until the mission is running again. Before closing, check that each row's status matches the work actually done (a skipped step is dropped with a note saying why; datum-studio_studio_mission_get with include rows, findings and deliverables shows them), write the final report, and write its mission index entry with the remember tool: kind "index", missionId, and text "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2 | docs/<mission-id>/10_report/report.md" (one line, at most 300 characters).
### datum-studio_studio_mission_set_status
Pause, then (another day) close:
```json
{"mission":"2026-11-08_example-mission","to":"paused","note":"what is open and why"}
{"mission":"2026-11-08_example-mission","to":"done"}
```
Close in one call. It is refused MISSION_ROWS_OPEN while a row is not done or dropped; on success it returns the decision register, decisions {count, ids}. Then write the record files with datum-studio_studio_mission_export (write true). They go under docs/<mission>/ in numbered folders (01_identification/ .. 10_report/; 11_deliverables/ is an export folder, not where final files go); a folder that already holds an older unnumbered export keeps it (folderLayout: legacy) and nothing is moved. When they exist add overwrite true and the old copies are kept in that folder's .bak/. Final files live in <project>/deliverables/<mission-id>/, copied there by datum-studio_studio_render after a verified render; for an extra copy beside the export use datum-studio_studio_file_verify, downloadDir "docs/<mission>/11_deliverables".

## Refusals: what each code means and the next call
A refusal reads "ditolak CODE: message", then rincian (details) and next (the next call). When it carries a line corrected, that line holds complete arguments for the same tool and one sentence on what changed: check them and make that call. When it carries fields instead, each entry names a wrong field and its allowed values. Fix the cause and call again; never work around a gate.
- SCHEMA_INVALID: an argument does not match the schema. Use corrected or fields; else read rincian.issues (path and message) or rincian.field and fix exactly those fields. rincian.field note: a row moved running -> done needs its note. On create, reread studio://skema/mission. If the issue is under session, leave session out.
- STATUS_TRANSITION: that status move is not allowed; rincian.allowed lists the moves from the current status (first table). Rows are added pending or dropped.
- MISSION_NOT_APPROVED: a row was started while the mission is a draft. Do step 3 first, then set the mission running, then the row update.
- APPROVAL_NEEDS_USER_DECISION: the approve call got a controller decision that is not an autonomous self-approval. Not autonomous: request a decision and wait for the person. Autonomous mode setting on: record a new decision with by controller and autonomous true, then approve with its id.
- AUTONOMOUS_MODE_OFF: Swarm's autonomous mode setting is off, so you cannot self-approve. Ask the person in Mission Control with datum-studio_studio_mission_request_decision and wait.
- DECISION_REQUIRED: the change needs a decision after approval. Record it with datum-studio_studio_mission_record_decision, then pass its id as decision on the call or on the patch.
- DEP_NOT_DONE: a build (:B) dependency is not done yet. datum-studio_studio_mission_get shows the rows that can start in derived.ready; use "N:C" when the row needs only the spec. A note in that patch was kept (noteSaved).
- OUTPUT_UNVERIFIED: the row's Studio deliverables are not verified. rincian.deliverables gives the reason per output: NOT_RENDERED, NOT_CHECKED or STALE (render, then verify, step 6), CHECK_FAILED or CHECK_UNKNOWN (fix the named checks; lintNotRun lists lint rules that did not run, pagesWithoutWitness the pages without a page image), NO_LAYOUT_WITNESS (no verified PDF or HTML of that revision: render one). Then mark the row done.
- DELIVERABLE_NOT_IN_PROJECT: the file of the revision is missing from deliverables/<mission-id>/ or its sha256 differs; it stops needs-review, done and a review request. Render the document again with datum-studio_studio_render, which makes the copy, then retry.
- PROJECT_UNWRITABLE: Swarm cannot write the project folder. Only the person can fix it: ask with datum-studio_studio_mission_request_decision and wait.
- KNOWLEDGE_NOT_CONSULTED: the row matched a domain of the pustaka pengetahuan teknis GSP and none of its files was read while the row ran. Read one file of rincian.domains with datum-studio_studio_library_read (with mission and row), or send knowledgeReason in the row patch saying why it does not apply, then retry done.
- DELIVERABLE_NOT_RETIRABLE: that document is not a draft of this row, or it is the last live deliverable. Retire only superseded drafts linked to the row and keep one live deliverable.
- DECISION_PENDING: an open decision request blocks the row. Wait for the person's answer in Mission Control, then retry.
- MISSION_PAUSED: the mission is paused, so no row may go running. Set the mission running first.
- MISSION_ROWS_OPEN: rincian.rows are not done or dropped. Finish them, or drop them with a note (and a decision after approval), then close again.
- MEMORY_INDEX_MISSING: the project memory has no index entry for this mission. Write it with the remember tool (kind "index", missionId), then close again. Other clients get warning MEMORY_INDEX_UNCHECKED instead.

Swarm's permission prompts and safety rules stay in force.
