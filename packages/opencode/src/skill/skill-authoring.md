# Skill authoring: draft a skill for the person to approve

Use this when the person asks for a new skill, a change to a skill, or when a procedure you worked out is worth keeping
as one. You only draft. A skill reaches a skills folder only when the person approves the draft in Settings > Skills.

## What you may and may not do
- Draft with the skill_draft tool. It takes a name, a scope and the full SKILL.md text, and never a path.
- Never write, edit, move or delete files in a skills folder (skill/, skills/, .agents/skills, .claude/skills) with
  edit, write, apply_patch, bash or any other tool. Those writes are refused in every mode. Do not look for another way.
- A draft is never loaded or offered to any agent until the person approves it. After drafting, tell the person the
  draft is waiting in Settings > Skills and what it does in one sentence.

## The draft
- name: lower-case letters, digits and hyphens, 1 to 64 characters, starting with a letter or digit. It equals the name
  in the frontmatter. Built-in names are reserved. A draft with the name of an earlier draft in the same scope
  replaces it.
- scope: "project" (this project only, the usual choice) or "global" (every project, only when the person asks).
- content: YAML frontmatter, then the instructions in Markdown, at most 64 KiB in all:

```markdown
---
name: invoice-check
description: Check a supplier invoice against its purchase order. Use when the person asks to verify an invoice.
triggers:
  keywords: [invoice, faktur, purchase order]
  files: ["**/*.invoice.pdf", "invoices/**"]
  missionTypes: [document]
---

# Invoice check
1. ...
```

- description: one line, at most 1024 characters. Say what the skill does and when to load it; it is what an agent
  reads in the list of skills.
- Body: short numbered steps a stranger could follow, the real tool names, and what to do when a step fails. No
  secrets, tokens, personal data or machine-specific paths.

## triggers (optional)
triggers suggest a skill and never load it. When the person's first message, a file it names, or a new mission's type
matches, Swarm lists the skill under suggested skills; the agent still decides whether to load it.
- keywords: words or phrases matched as whole words, case-insensitive. Each 1 to 40 characters.
- files: glob patterns for file paths, such as "**/*.invoice.pdf"; a pattern without / matches the file name. Each 1 to
  100 characters.
- missionTypes: Mission Control mission types, matched exactly, case-insensitive.
- At most 10 entries per list and no other keys. Invalid triggers refuse the draft (SKILL_TRIGGERS_INVALID).
- Pick words a later request about the same subject would contain, in the person's languages. Avoid common words that
  would suggest the skill for unrelated work.

## Commands in a skill
A skill text that runs shell commands (an exclamation mark directly before a command in backticks) is marked for the
person, and saving it needs the person's explicit confirmation in Settings > Skills. Draft one only when the person
asked for it, and tell them the draft runs commands and which ones. Prefer steps that name tools over embedded commands.

## Refusals
skill_draft answers with a code and the rule. Fix the cause and draft again: SKILL_NAME_INVALID (name rule),
SKILL_NAME_RESERVED (choose another name), SKILL_TOO_LARGE (shorten), SKILL_FRONTMATTER_INVALID (name and a one-line
description), SKILL_TRIGGERS_INVALID (the rules above), SKILL_DRAFTS_FULL (20 drafts wait in that scope: ask the person
to approve or discard some first).
