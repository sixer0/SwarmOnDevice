<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (SkillPlugin.Plugin) and at
  packages/opencode/src/skill/index.ts (CUSTOMIZE_SWARM_SKILL_NAME and
  CUSTOMIZE_SWARM_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Customizing Swarm

Swarm validates its own config strictly and refuses to start when a field
is wrong. The shapes below cover the common surface area, but they are a
**summary, not the source of truth**.

## Full schema reference

Upstream OpenCode published its option list at a hosted JSON Schema URL. Swarm
is a separate product and publishes no schema of its own: there is no Swarm
documentation site, no hosted schema, and no URL to fetch. If a field is not
documented in this skill, or you need to confirm an exact shape before writing
config, read the schema source in the installed Swarm or ask the user for it
rather than guessing, and never invent a documentation or schema URL. Swarm
hard-fails on invalid config, so the cost of a wrong shape is a broken startup.

`$schema` is an accepted optional key in the config format, but Swarm never
writes one. Do not add it to a user's config; keep it only if the user already
put it there deliberately.

## Applying changes

Config is loaded once when Swarm starts and is not hot-reloaded. After
saving changes to `swarm.json`, an agent file, a skill, a plugin, or any
other config-time file, **tell the user to quit and restart Swarm** for
the changes to take effect. The running session will keep using the
already-loaded config until then.

## Where files live

| Scope                         | Path                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Project config                | `./swarm.json`, `./swarm.jsonc`, or `.swarm/swarm.json` (Swarm walks up from the cwd to the worktree root) |
| Global config                 | `~/.config/swarm/swarm.json` or `~/.config/swarm/swarm.jsonc` (NOT `~/.swarm/`)                            |
| Project agents                | `.swarm/agent/<name>.md` or `.swarm/agents/<name>.md`                                                      |
| Global agents                 | `~/.config/swarm/agent(s)/<name>.md`                                                                       |
| Project commands              | `.swarm/command/<name>.md` or `.swarm/commands/<name>.md`                                                  |
| Global commands               | `~/.config/swarm/command(s)/<name>.md`                                                                     |
| Project skills                | `.swarm/skill(s)/<name>/SKILL.md`                                                                          |
| Global skills                 | `~/.config/swarm/skill(s)/<name>/SKILL.md`                                                                 |
| External skills (auto-loaded) | `~/.agents/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`; `.claude/skills` only with `claude_compat` |
| Global instructions           | `~/.config/swarm/SWARM.md` (fallback `~/.config/swarm/AGENTS.md`)                                         |
| Project instructions          | `SWARM.md`, else `AGENTS.md` (Swarm walks up from the cwd to the worktree root)                            |

Configs from each scope are deep-merged. Project overrides global. Unknown
top-level keys in `swarm.json` are rejected with `ConfigInvalidError`.

## Instructions and Claude Code compatibility

Every agent gets Swarm's built-in rules first. Then, in this order:

1. Global: `~/.config/swarm/SWARM.md`, else `~/.config/swarm/AGENTS.md`. The
   user writes this file; Swarm never creates or edits it.
2. Project: the first name found from the cwd up to the worktree root, in the
   order `SWARM.md`, `AGENTS.md`, `CONTEXT.md`. A nested `SWARM.md` or
   `AGENTS.md` is attached when the agent reads a file in that folder.
3. `instructions` paths and URLs from `swarm.json`.

Later text may add to or narrow the built-in rules; it never lifts Swarm's
permission prompts or safety rules.

Swarm does not read Claude Code files by default: `~/.claude/CLAUDE.md`,
project `CLAUDE.md`, `~/.claude/skills` and project `.claude/skills` are
ignored. To read them again, set `"claude_compat": true` in the GLOBAL config
(Settings > General > Claude Code compatibility in the app). A project
`swarm.json` cannot turn it on. With it on, `~/.claude/CLAUDE.md` comes after
the global SWARM.md/AGENTS.md (used only when neither exists) and project
`CLAUDE.md` after `AGENTS.md`. `SWARM_DISABLE_CLAUDE_CODE=1` (and the `_PROMPT`
/ `_SKILLS` variants) still force them off. Multi-step work follows the
built-in `swarm-workflow` skill either way; `master-controller` from
`~/.claude/skills` loads only when the user asks for it.

## swarm.json

Every field is optional.

```json
{
  "username": "string",
  "model": "provider/model-id",
  "small_model": "provider/model-id",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "share": "manual" | "auto" | "disabled",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "skills": {
    "paths": [".swarm/skills", "/abs/path/to/skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  },

  "references": {
    "docs": {
      "path": "../docs",
      "description": "Use for product behavior and documentation conventions"
    },
    "sdk": {
      "repository": "owner/sdk",
      "branch": "main",
      "description": "Use for SDK implementation details",
      "hidden": true
    }
  },

  "agent": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-6",
      "mode": "subagent",
      "description": "...",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "template": "..." }
  },

  "provider": {
    "anthropic": { "options": { "apiKey": "..." } }
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"],

  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "environment": {}
    },
    "remote-thing": {
      "type": "remote",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." }
    }
  },

  "plugin": [
    "example-gemini-auth",
    "example-foo@1.2.3",
    "./local-plugin.ts",
    ["example-bar", { "option": "value" }]
  ],

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": {
    "primary_tools": ["edit"],
    "mcp_timeout": 30000
  },

  "tool_output": { "max_lines": 200, "max_bytes": 8192 },

  "compaction": { "auto": true, "tail_turns": 15 }
}
```

Shape notes worth being explicit about:

- `model` always carries a provider prefix: `"anthropic/claude-sonnet-4-6"`.
- `skills` is an object with `paths` and/or `urls`, not an array.
- `references` is an object keyed by alias. Each value is a local path, Git repository, or string shorthand.
- `agent` is an object keyed by agent name, not an array.
- `command` is an object keyed by command name, not an array.
- `plugin` is an array of strings or `[name, options]` tuples, not an object.
- `mcp[name].command` is an array of strings, never a single string. `type` is required.
- `permission` is either a string action or an object keyed by tool name.

## Skills

Swarm's skill loader scans for `**/SKILL.md` inside skill directories. The
file is named `SKILL.md` exactly, and lives in its own folder named after the
skill:

```
.swarm/skills/my-skill/SKILL.md
```

Frontmatter:

```markdown
---
name: my-skill
description: One sentence covering what this skill does AND when to trigger it. Front-load the literal keywords or filenames the user is likely to say.
---

# My Skill

(skill body in markdown: instructions, examples, references)
```

- `name` is required, lowercase hyphen-separated, up to 64 chars, and matches the folder name.
- `description` is effectively required: skills without one are filtered out and never surfaced to the model. Cover both _what_ the skill does and _when_ to use it. Write in third person ("Use when...", not "I help with..."). Front-load concrete trigger keywords and filenames; gate with "Use ONLY when..." if the skill should stay quiet on adjacent topics.
- Optional: `license`, `compatibility`, `metadata` (string-string map).

Register skills from non-default locations via `skills.paths` (scanned
recursively for `**/SKILL.md`) and `skills.urls` (each URL serves a list of
skills).

## References

References make local directories and Git repositories outside the active
project available as supporting context. Configure them under `references`,
keyed by the alias used in `@` autocomplete:

```json
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Use for product behavior and terminology"
    },
    "effect": {
      "repository": "Effect-TS/effect",
      "branch": "main",
      "description": "Use for Effect implementation details"
    }
  }
}
```

Local `path` values may be relative to the declaring config, absolute, or use
`~/`. Git `repository` values accept Git URLs, host/path references, and GitHub
`owner/repo` shorthand; `branch` is optional. Both forms support optional
`description` and `hidden` fields.

- Only references with a `description` are advertised to agents in system context.
- `hidden: true` removes a reference from TUI `@` autocomplete only. It remains available to agents and by direct path.
- Reference directories are automatically allowed through the external-directory boundary; normal read/edit/tool permissions still apply.
- String shorthand is supported: use `"docs": "../docs"` for local paths or `"effect": "Effect-TS/effect"` for Git repositories.

## Agents

Two ways to define an agent. Use the file form for anything non-trivial.

### Inline (in `swarm.json`)

```json
{
  "agent": {
    "my-reviewer": {
      "description": "Reviews PRs for style violations.",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "You are a strict PR reviewer..."
    }
  }
}
```

### File

```
.swarm/agent/my-reviewer.md      OR     .swarm/agents/my-reviewer.md
```

```markdown
---
description: Reviews PRs for style violations.
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

You are a strict PR reviewer. Focus on...
```

The file body becomes the agent's `prompt`. Do not also put `prompt:` in the
frontmatter.

`mode` is one of `"primary"`, `"subagent"`, `"all"`.

Allowed top-level frontmatter fields: `name, model, variant, description, mode,
hidden, color, steps, options, permission, disable, temperature, top_p`. Any
unknown field is silently routed into `options`.

To disable a built-in agent: `agent: { build: { disable: true } }`, or in a
file, `disable: true` in frontmatter.

`default_agent` must point to a non-hidden, primary-mode agent.

### Built-in agents

Swarm ships with `build`, `plan`, `general`, `explore`. Hidden internal agents:
`compaction`, `title`, `summary`. To override a built-in's fields, define the
same key in `agent: { <name>: { ... } }`.

## Commands

Swarm's command loader scans for `**/*.md` inside command directories. The
file is named after the command, and lives directly inside the `command` folder:

```
.swarm/command/deploy.md
```

Frontmatter:

```markdown
---
description: One sentence describing what the command does.
agent: build
model: anthropic/claude-sonnet-4-6
---

(command body in markdown: the prompt Swarm runs, with $ARGUMENTS for the user's input)
```

- `template` is the command body — everything below the frontmatter — and is required: it is the prompt Swarm runs when the command is invoked. Do not also put a `template:` key in the frontmatter.
- `$ARGUMENTS` is replaced with everything the user typed after the command; `$1`, `$2`, … pull individual positional arguments.
- Optional: `description`, `agent`, `model`, `variant`, `subtask`.

## Plugins

`plugin:` is an array. Each entry is one of:

```json
"plugin": [
  "example-gemini-auth",             // npm spec, latest
  "example-foo@1.2.3",               // npm spec, pinned
  "./local-plugin.ts",               // file path, relative to the declaring config
  "file:///abs/path/plugin.js",      // file URL
  ["example-bar", { "key": "val" }]  // tuple form with options
]
```

The names above are placeholders. Swarm installs no plugin for the user at
runtime, so a spec here only resolves a package the user added themselves.

Auto-discovered plugins (no config entry needed): any `*.ts` or `*.js` file in
`.swarm/plugin/` or `.swarm/plugins/`.

A plugin module exports `default` (or any named export) of type
`Plugin = (input: PluginInput, options?) => Promise<Hooks>`. The export is a
function, not a plain object literal, and the function returns an object
(return `{}` if there is nothing to register).

```ts
import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ client, project, directory, $ }) => {
  return {
    config: (cfg) => {
      // cfg is the live merged config; mutate fields here.
    },
    "tool.execute.before": async (input, output) => {
      // mutate output.args before the tool runs
    },
  }
}) satisfies Plugin
```

Hook surface (mutate `output` in place; return `void`):

- `event(input)`: every bus event
- `config(cfg)`: once on init with the merged config
- `chat.message`, `chat.params`, `chat.headers`
- `tool.execute.before`, `tool.execute.after`
- `tool.definition`
- `command.execute.before`
- `shell.env`
- `permission.ask`
- `experimental.chat.messages.transform`, `experimental.chat.system.transform`,
  `experimental.session.compacting`, `experimental.compaction.autocontinue`,
  `experimental.text.complete`

Special object-shaped (not callbacks): `tool: { my_tool: { ... } }`,
`auth: { ... }`, `provider: { ... }`.

## MCP servers

`mcp:` is an object keyed by server name. Each server is discriminated by
`type`:

```json
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "environment": { "BROWSER": "chromium" }
    },
    "github": {
      "type": "remote",
      "url": "https://...",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    },
    "old-server": { "enabled": false }
  }
}
```

`command` is an array of strings. `environment` sets environment variables for
a local MCP server. `type` is required. Use `enabled: false` to
disable a server inherited from a parent config. String values such as header
tokens support `{env:VAR}` interpolation (and `{file:path}`); the shell-style
`${VAR}` is not substituted.

## Permissions

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

Actions: `"allow"`, `"ask"`, `"deny"`.

Per-tool value forms: `"allow"` shorthand (treated as `{"*": "allow"}`), or an
object `{ pattern: action }`. Within an object, **insertion order matters**.
Swarm evaluates the LAST matching rule, so put broad rules first and narrow
rules last.

`permission: "allow"` (a string at the top level) is shorthand for "allow
everything" and is rarely what the user wants.

Known permission keys: `read, edit, glob, grep, list, bash, task,
external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop,
skill`. Some of these (`todowrite,
question, webfetch, websearch, doom_loop`) only accept a flat
action, not a per-pattern object.

`external_directory` patterns are filesystem paths (use `~/`, absolute paths,
or globs like `~/projects/**`).

Per-agent `permission:` overrides top-level `permission:`. Plan Mode lives on
the `plan` agent's permission ruleset (`edit: deny *`).

## Escape hatches

When a user's config is broken and Swarm won't start, these env vars help.
Public names use the `SWARM_` prefix; Swarm still reads the `OPENCODE_` twin of
each, and when both are set the `SWARM_` value wins.

- `SWARM_DISABLE_PROJECT_CONFIG=1`: skip the project's local `swarm.json`
  and start from globals only. Run from the project directory, Swarm loads,
  the user edits the broken file, then they restart without the flag.
- `SWARM_CONFIG=/path/to/file.json`: load an additional explicit config.
- `SWARM_CONFIG_CONTENT='{"logLevel":"DEBUG"}'`: inject inline JSON as a
  final local-scope merge.
- `SWARM_DISABLE_DEFAULT_PLUGINS=1`: skip default plugins.
- `SWARM_PURE=1`: skip external plugins entirely.
- `SWARM_DISABLE_EXTERNAL_SKILLS=1`: skip the external skill scans under
  `.claude/` and `.agents/`. `SWARM_DISABLE_CLAUDE_CODE_SKILLS=1` and
  `SWARM_DISABLE_CLAUDE_CODE_PROMPT=1` (both: `SWARM_DISABLE_CLAUDE_CODE=1`)
  keep the `.claude` skills and `CLAUDE.md` off even with `claude_compat` on.

Path-valued variables (`SWARM_CONFIG`, `SWARM_CONFIG_DIR`, `SWARM_TUI_CONFIG`,
`SWARM_DB`, `SWARM_AUTH_CONTENT`, `SWARM_PLUGIN_META_FILE`) are dropped when
they resolve inside an OpenCode location, so Swarm can never read an OpenCode
config or data path. Point them at Swarm locations.

## When proposing edits

- Validate against the shapes in this skill first. When a field is missing or
  unclear, read the schema source in the installed Swarm or ask the user, rather
  than guessing and rather than fetching a URL: Swarm publishes no hosted schema.
- Never write a documentation, schema, or support URL into a user's config or
  reply, and never present an upstream OpenCode link as Swarm's own.
- Preserve any existing fields the user did not ask to change, including a
  `$schema` key the user added themselves.
- For agent, command, skill, and plugin definitions, prefer creating new files
  in the correct location over inlining everything in `swarm.json`.
- If the user's existing config is malformed, point them at the env-var escape
  hatches above so they can edit from inside Swarm without breaking their
  session.
- After saving any config change, remind the user to quit and restart Swarm
  — running sessions keep using the already-loaded config.
