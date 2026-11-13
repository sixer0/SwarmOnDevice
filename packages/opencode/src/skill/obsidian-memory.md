# Obsidian memory: what agents write to the vault

This skill cannot be turned off. Swarm already copies project memory, mission index entries and final reports into
the vault folder `swarm-memory/` by itself. You never write, edit, rename or delete anything in `swarm-memory/`, and
you never write into the vault with edit, write, bash or any tool other than `swarm-web_vault_inbox`.

## When you write a note
1. Mission close: after `studio_mission_set_status` returned `done` or `cancelled`, write one note.
2. Lasting decision: when a decision is recorded (`studio_mission_record_decision`, or the person states a rule) that
   still applies after this mission ends: a convention, a policy, an architecture or tool choice, a preference of the
   person. One note per decision, at most 5 per mission; more go into one combined note. Row-level choices that end
   with the mission are not lasting.

## How
- `swarm-web_vault_inbox` with action `write`, a `name` and the `content`. The name is a plain file name with no
  folder, for example `<mission-id>-closed.md`. Writes only create: if the name is taken, pick another, never overwrite.
- Write in the person's language. Start with YAML frontmatter:
  tags: `swarm-memory/mission/<mission-id>` (lowercase mission id). Always set this tag, on every note.
- Body: a heading (`Mission closed: <mission-id>` or `Decision: <short title>`, in the person's language), then
  outcome or decision, the reason, and links.
- Links: the close result ends with a line `next: write the vault note for this mission (skill obsidian-memory); link
  [[<mission note name>]] and [[<report note name>]].` Copy exactly those two links into the note. When the line has
  no links (the mission has no index entry), or the note is a lasting decision written before the close, link by the
  tag only. Never make up a note name and never write a vault path.
- No secrets, tokens, credentials, addresses of private servers or personal data. If the mission's documents are
  TERBATAS or RAHASIA, write only the mission id, date, status and links: no summary of their content.

## When you cannot
- If `swarm-web_vault_inbox` is not in your tool list, or the person declines the call, do not retry and do not use
  another way into the vault. Say once in your final message that the vault note was not written and why.
- Always write the mission index entry first (`remember` with kind "index", skill swarm-workflow); the vault note
  comes after the close, never instead of the index entry.
