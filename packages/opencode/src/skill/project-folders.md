# Project folders: propose a group, never move

Use this when you create a mission and your session folder is the Default Project root (the folder named
"Default Project" directly in Documents), or when the person asks to tidy, group or sort their missions.
It does not apply to missions in any other folder.

Groups are one-level folders inside the Default Project, each marked by .swarm/group.json. A group is a
product, an institution, or a research theme. Swarm moves a mission into a group only when the person
clicks in Mission Control. You only propose.

## At mission creation
1. After studio_mission_create, find the groups: glob "*/.swarm/group.json" in the Default Project root
   and read each file (name, kind).
2. Compare the mission title, type and first rows with each group: same product, institution or theme
   name (strong); a group whose missions share the mission's subject (strong); a proper noun or acronym
   in the title that names an institution or product (medium); same mission type only (weak).
   Confidence high = a strong match; medium = one medium match; low = weak or none.
3. Call studio_mission_request_decision once with topic "project-placement", options in this order:
   join (only if a group exists; group = best match), new (group = a short Title Case name, at most 60
   characters, no slash or backslash, not starting with a dot, not "docs"), root. Set recommended: join
   when high, new when medium, root when low. Put "confidence <level>: <signal>" in context. groupKind on
   join and new is product, institution or theme. Do not set blockingRows: keep working at the root.
4. Never answer this request yourself, not even in autonomous mode. Never call studio_mission_place: it
   belongs to the person, and Swarm calls it after their click.

## Tidying existing missions
1. studio_mission_list for the Default Project root; keep only missions whose project dir is exactly the
   root. Read titles with studio_mission_get when the list is not enough.
2. Build one proposal: for each mission a group (existing or new) or null to stay at the root, with
   groupKind. Prefer few groups; a new group needs at least two missions unless the person named it.
3. Call studio_mission_request_decision once with topic "project-tidy", options approve and decline, and
   the proposal (at most 200 items). Tell the person to check it in Mission Control.
4. More than 200 missions: send them in batches of 200, one request per batch, each approved once. Say in
   context which batch it is (for example "batch 1 of 3"), and send the next batch only after the person
   answered the previous one.
5. Do not move, rename, copy or delete any mission folder, memory file or session yourself. If the
   person wants changes, send a new request.

After the person clicks, Swarm moves the mission folder, its sessions and its memory notes together and
keeps a backup of the old memory store. If a move fails it is undone; report the message to the person.
