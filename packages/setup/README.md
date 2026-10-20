# swarm-setup — program skeleton (row 81)

`swarm-setup` (register `PC-PKG-01`) is the **separate, unprivileged, consent-first**
pre-install program that fetches, verifies, installs, configures and health-checks up to
seven optional components on macOS arm64. It is distinct from `install.sh`, from the
`swarm` binary, and from any root `.pkg` (blocker B1 / conflict X-2). This directory is
the skeleton created by blueprint row 81; rows 82-98 add behaviour on top of it.

The design contract lives in `docs/.../masterplan/01c_preinstall_spec.md` (THE spec) and
its constants in `masterplan/01c0_preinstall_register.md`. Read both before writing a step.

## What row 81 ships (and what it deliberately does NOT)

| Ships here                                                                                                                       | Owned by a later row                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Command surface `install` / `status` / `remove` (+ `--remove`, `--non-interactive`, `--terms-token`, `--dry-run`) — frozen verbs | consent UI + policy gate (row 83), full remove deletion (rows 90+/97) |
| State-machine engine: atomic read/write of `state.json` per the §4.2 envelope, kill-9 safe                                       | per-component transitions driven by steps                             |
| Lock directory (`~/.swarm/setup/lock`) with stale-pid reclaim                                                                    | —                                                                     |
| Fail-closed `tools.lock.json` loader (parse + structural validate + host allow-list)                                             | fetch/verify against the pins (row 82)                                |
| Consent gate FIRST (plain-text host list + unticked list; refuses without consent)                                               | nine-field consent screen, EULA links, egress statements (row 83)     |
| Step self-registration by directory scan + topological order                                                                     | the actual step modules (rows 82-98)                                  |
| Failure-outcome taxonomy with `0`/`1` exit codes (gate D-23)                                                                     | component-specific failure handling                                   |

No network code, no component behaviour, no port binding, no UI beyond plain text.

## Layout

```
packages/setup/
├── package.json            @swarm/setup; scripts: typecheck (tsc --noEmit), genlock, build (genlock + bun --compile)
├── tsconfig.json           self-contained (types:[]); see "Toolchain" below
├── tools.lock.json         GENERATED copy of masterplan/01c1_tools_lock.json — regenerate via `bun run genlock`, never hand-edit (row 106 / V-1 fix; archive mode is row 48's packager: 0o644)
├── README.md               this file
├── script/
│   └── gen-lock.ts         row-106 lock generator: byte-copy from the authoritative masterplan file + sha256 record + shipped-validator check (fail-closed)
├── types/env.d.ts          minimal ambient decls for the builtins the skeleton touches
├── src/
│   ├── index.ts            entry point: gates -> dispatch -> outcome/exit code
│   ├── cli.ts              verb + flag parsing (frozen verbs/flags only)
│   ├── constants.ts        register PC-* values used VERBATIM, each cited
│   ├── outcomes.ts         failure-outcome taxonomy + exit codes (D-23: 0/1)
│   ├── gates.ts            platform gate (P-20) + root refusal (P-4)
│   ├── paths.ts            ~/.swarm path resolution (honors $HOME; P-16 whitelist)
│   ├── atomic.ts           tmp+fsync+rename writes (kill-9 safe)
│   ├── lockdir.ts          lock acquire/release + stale-pid reclaim
│   ├── state.ts            state machine engine (§4 envelope, single-writer commit)
│   ├── lockfile.ts         tools.lock.json loader (fail-closed)
│   ├── consent.ts          consent gate FIRST (plain-text; row 83 owns the UI)
│   ├── steps.ts            directory-scan discovery + topological order
│   └── steps/
│       └── _template/      authoring example (underscore-prefixed => NOT a component)
│           ├── step.json
│           └── index.ts
└── test/proofs.sh          the five row-81 proof commands
```

## How to add a step (rows 82-98)

1. Copy `src/steps/_template/` to `src/steps/<component_id>/`, where `<component_id>` is
   exactly one of `runtime node graft rtk obsidian searxng firecrawl` (`PC-CMP-01..07`).
   The **directory name must equal** `step.json.id`; one id serves the state key, the
   `~/.swarm/tools/<id>` dir, and the `io.gsp.swarm.component` label.
2. Edit `step.json`: set `order` (tie-break only) and `requires` (other component ids this
   step needs first, e.g. graft uses `["node"]`). Real sequencing comes from `requires`.
3. Implement `index.ts` exporting a `StepModule` (`install(ctx)` / `remove(ctx)`). Call the
   shared fetch/verify library (row 82) — do **not** inline network primitives. Advance state
   only through the engine helpers in `src/state.ts` (single-writer rule A-73-3).
4. Do not edit the core modules above: they are shared and owned by row 81. Your step is one
   new directory; the scan picks it up automatically (there is no registry file to touch).

### Hard boundaries every step must respect (from the spec + gate)

- **No network outside row 82's verify/fetch library.** HTTPS only, host in the lock
  `hosts` allow-list, size cap, hash/digest verified before any use (P-1/P-18). No `curl | bash`
  or pipe-to-shell (P-3). Never weaken TLS (`--insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  `GIT_SSL_NO_VERIFY`, `ignore_ssl`) (P-17).
- **Unprivileged only.** No `sudo`, `osascript ... administrator`, `chmod`/`chown` outside
  `~/.swarm`. A step needing admin returns `SKIPPED_WITH_INSTRUCTIONS` and prints the exact
  manual command (P-4).
- **Bind no port.** Ports are compose-side constants (`PC-PORT-*`); the setup never listens.
- **Write only inside the P-16 whitelist**: `~/.swarm/**`, `~/.config/swarm/**`, the `swarm`
  Colima profile dir, `/Applications/Obsidian.app` only if absent. Never `~/.claude`,
  `~/.codex`, `~/.config/opencode`, rc files.
- **Secrets**: generated at install, written to `~/.swarm/tools/<id>/secrets/<name>` (dir 0700,
  file 0600), never in argv, never echoed, redacted in `setup.log` (P-8).
- **MCP/config entries are written only after `healthy`** (P-15); a health failure leaves no
  partial state.

## Toolchain (spec §10)

Language is **TypeScript**, compiled by **Bun `--compile`** to a single self-contained Mach-O
arm64 binary. The same toolchain that already produces the `swarm` CLI (spec §10, IS-R21).

**Row 106 finalised the artifact build.** `bun run build` now runs `script/gen-lock.ts` first —
the V-1 structural fix from r80c: `tools.lock.json` here is a GENERATED byte-copy of the
authoritative `docs/<task>/masterplan/01c1_tools_lock.json` (hash recorded on stdout, validated
through the shipped `lockfile.ts` validator, fail-closed on any drift), then compiles. The
release-style binary is placed OUTSIDE the repo under `tools/build/swarm-setup-darwin-arm64/`
(executable + its adjacent `tools.lock.json`; `paths.resolveProgramDir()` resolves the lock via
`dirname(process.execPath)`). The `--help` banner prints only the version this program can
substantiate — the lock's `.version` field; the CLI product version behind `OPENCODE_VERSION`
(register V09) belongs to the `swarm` binary and is deliberately absent here.

This checkout's `node_modules` does not carry `@types/node`/`@types/bun` (the handoff did not
copy them) and this row must not run `bun install` (red line: no change to tracked `bun.lock`
or the machine's tooling). So `tsconfig.json` is **self-contained** (`"types": []`) and
`types/env.d.ts` declares exactly the builtins the skeleton uses. Row 106 builds against the
full catalog.

```sh
export PATH="$(cd .. && pwd)/tools/node_modules/.bin:$PATH"   # local bun only (workspace tools dir, sibling of the repo; run from repo root)
bun --version                       # 1.3.14
node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json     # typecheck
bun build --compile --target=bun --outfile /tmp/swarm-setup packages/setup/src/index.ts
file /tmp/swarm-setup               # Mach-O arm64
```

Run targeted at this package only — do not trigger workspace-wide builds/tests from here.

## Exit codes (gate D-23)

`0` = success-or-skipped; `1` = every refusal / failure / network-blocked outcome. The
specific outcome is carried as a machine-readable `RESULT <TOKEN>` line on stdout and, for
components, as the `PC-ST-*` value in `state.json`. `BLOCKED_BY_NETWORK` is distinguished by
its token + state value, **not** by a second exit code.

## Step-engine helpers (row 84) — for step authors (rows 86-90)

Row 84 adds two library modules that every component step should build on, so the ordering,
state, logging and outcome rules are written once instead of seven times. They are **services,
not scanned steps** (like `fetch`/`verify`/`provenance`): no `src/steps/<id>/` directory, no core
module edited. Import them from your step's `index.ts`.

```ts
import { createStepKit, stepOutcomeFromFetch, policyMalformedOutcome, outcomeTokenFor } from "../../stepkit.ts"
import type { StepContext } from "../_template/index.ts" // engine passes { lock, state, dryRun }

export const step: StepModule = {
  id: "node",
  async install(ctx: StepContext) {
    const kit = createStepKit({ componentId: "node", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })

    // 1. CONSENT GATE FIRST (01c §11). kit.fetch() refuses with REFUSED_NO_CONSENT unless
    //    consent.ts's consentWasGranted("node") is true — enforcement layer 2, on top of the
    //    durable recording evaluateConsent already made. Never call fetchArtifact directly.
    const out = await kit.fetch() // dry-run propagates automatically
    if ("token" in out) return { token: out.token } // consent refusal
    if ("ok" in out && out.ok === false) return { token: outcomeTokenFor(out.code), message: out.message }

    // 2. STATE TRANSITIONS ONLY VIA THE ENGINE. kit.transition() validates the §4.1 lifecycle
    //    and commits through state.ts setState (single-writer A-73-3). An illegal move is
    //    refused with ZERO writes — never write state.json yourself.
    kit.transition("downloaded")
    kit.registerSecret(generatedSecretValue) // P-8: scrub any value you generate from setup.log
    kit.log("info", "artifact placed", { context: { destPath: out.destPath } }) // redacted
    kit.transition("verified", { integrity: "sha256:..." })
    // ... installed -> configured -> healthy; MCP entries only after healthy (P-15).
    return { token: stepOutcomeFromFetch(out) }
  },
}
```

| Helper                                                                    | Guarantees for you                                                                                               | Owner of the rule it enforces            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `createStepKit({componentId, lock, state, dryRun, correlationId?, log?})` | one object carrying the four hard rules below                                                                    | row 84 wiring                            |
| `kit.hasConsent()` / `kit.fetch(opts?)`                                   | refuses before any socket unless `consentWasGranted(id)`; injects `dryRun` into row 82's zero-write posture      | consent.ts (row 83) + fetch.ts (row 82)  |
| `kit.artifact(artifactId?)`                                               | zero-network pin pre-flight (`resolveArtifact`) scoped to your component                                         | fetch.ts (row 82)                        |
| `kit.transition(to, patch?)`                                              | rejects illegal lifecycle moves; commits ONLY via `state.ts setState`; records an in-memory marker under dry-run | state.ts (row 81)                        |
| `kit.log(level, message, {context?})`                                     | writes one redacted JSONL line to `setup.log` (PC-PATH-05, 0600, size-capped rotation)                           | setuplog.ts (row 84)                     |
| `kit.registerSecret(value)`                                               | every later line scrubs that literal wherever it appears                                                         | setuplog.ts (row 84)                     |
| `outcomeTokenFor` / `stepOutcomeFromFetch`                                | map fetch results onto the frozen §8 token set (exit stays 0/1, gate D-23)                                       | outcomes.ts (row 81) + fetch.ts (row 82) |
| `policyMalformedOutcome()`                                                | the malformed-policy reuse decision (returns `FAILED`, not a new token)                                          | outcomes.ts seam (see below)             |

**Redaction contract (P-8).** `setup.log` never carries a secret. Three layers scrub it: any
context key whose name looks secret (`SEARXNG_SECRET`, `*_PASSWORD`, `*_TOKEN`, `BULL_AUTH_KEY`,
`FIRECRAWL_API_KEY`, …) is replaced structurally; any value you pass to `kit.registerSecret()` is
scrubbed verbatim; and bearer/token/basic/digest credential headers plus the non-interactive term-token
shape `<component_id>@<lock_sha256_12>` are redacted by pattern. So: pass generated secrets to
`registerSecret`, put structured facts in `context` (secret-named keys are safe there), and never
hand a raw secret to `console.log`. Per gate item D-04 the secrets themselves live as one 0600 file
per secret under `~/.swarm/tools/<id>/secrets/` (dir 0700) — rendering those files is your step's job
(rows 86-90), but registering their values with `kit.registerSecret` is how you keep them out of the log.
Per D-22, do not mount a secret file you did not create (an unreadable secret path is a start failure,
not a silent downgrade).

**Seam reported (outcomes.ts ownership).** A malformed `policy.json` currently exits `1` as `FAILED`
with the path named on stderr (row 83's decision); a dedicated `REFUSED_POLICY_MALFORMED` token would
require editing `outcomes.ts`, which is row-81 owned. `policyMalformedOutcome()` centralises that so
the change is one line if the token is ever added. Rows 108/109 assert the outcome token, not a code.

Proofs: `bash test/stepkit.proofs.sh` (typecheck + Mach-O, unit suite, redaction before/after, grep
gates). Targeted to this package only.

## Compose-file renderer (row 85) — for step authors (rows 91/92/93)

Row 85 adds `src/composefiles/`, the renderer for the two compose projects of
`masterplan/01e_compose_spec.md`. Like fetch (r82) and stepkit (r84) it is a **service, not a
scanned step**: 01c §9 restricts scanned directories to the seven PC-CMP component ids, so a
`compose-files` step directory would fail every install closed; the component steps (rows 91/92
per stack) call this renderer instead. Its own CLI prints the registration:
`bun run src/composefiles/index.ts status`.

| Export                                   | Guarantees for you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderAll(lock, ctx)`                   | Pure render of searxng.yml + firecrawl.yml (01e §5/§6 structure; every image value read from `tools.lock.json`, every label/port/project from `constants.ts`), settings.yml (§8 incl. the H-11 engine path), nginx `default.conf.template` (§6.3 auth_request form), `searxng.env`, squid filtering config (§10.4), and the §4.7 bin wraps. Refuses when a required secret slot is not declared generated (§4.9 unset-required-secret) and refuses any output failing its own lint — incl. **F-79-E** (every `io.gsp.swarm.version` label must equal `lock.version`). Byte-stable by contract: two renders are identical. |
| `ctx.secrets` (SecretManifest)           | The declared delegation interface to the generation owners (rows 84/86/91/92): you generate per §4.6 commands, write the files under `~/.swarm/tools/<id>/secrets/` (dir 0700/file 0600, D-04), register each value with `kit.registerSecret`, then tell this renderer only WHICH slots are `generated`. Optional secrets render their binds/wraps only then (D-22); the renderer never sees or makes a value.                                                                                                                                                                                                            |
| `ctx.enginePath` / `ctx.defaultSettings` | H-11 merge-prune: supply the pinned image's own `/usr/local/searxng/searx/settings.yml` (extract once via `docker run --rm --entrypoint cat <pinned> ...`, 01e §8.1 — row 92's tooling) and the settings render switches to the mechanically generated `use_default_settings.engines.remove` list. Without it you get the curated-four + `categories_as_tabs: {}` fallback marked [H] for row 111.                                                                                                                                                                                                                        |
| `ctx.caBundlePath`                       | F-79-B presence flag drives the conditional read-only CA mounts + `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` (§4.10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `applyRenderedFiles(result, root?)`      | Atomic writes (row-81 atomic.ts) at the declared modes; returns the absolute paths to record via `kit.transition(id, { paths })` (D-17). Dry-run: pass a temp root (PORT RULE: dry-run renders to temp only).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `validateRenderedSecrets(values)`        | P-8 placeholder refusal over resolved values (`ultrasecretkey`, `postgres`, short tokens) — call before substituting `$SEARXNG_SECRET`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lintComposeText(text, {lockVersion})`   | The §4.9 rule set + gate additions (named-volume ban both stacks, no literal `~` in source/env_file, version-label equality, CA mount `:ro`), one failing+passing fixture per rule in `test/compose_files.test.ts`. Proofs: `bash test/compose.proofs.sh`.                                                                                                                                                                                                                                                                                                                                                                |

Boundaries honored here: the renderer binds no port, spawns no process, touches no network
(docker extraction is delegated by interface, not invoked); it writes nothing itself — placement
is `applyRenderedFiles` called by the owner step through the row-81 atomic writer.

## Node step (row 87) — resolver contract for rows 88/89

`src/steps/node/` is the first real scanned step: it installs the pinned official Node
tarball (PC-CMP-02 / PC-PIN-05, `nodejs.org` on the amended P-18 list) into the PRIVATE
directory `~/.swarm/tools/node/<version>/` — never a system prefix, never PATH. Fetch goes
through `kit.fetch()` (consent layer 2 + row-82 verification); extraction is atomic (same-dir
temp + one rename); idempotence is decided by hashing the private **binary** against the digest
recorded in `<version>/.swarm-node.json` (never by directory name); removal deletes only the
paths this component listed in `state.json`, and only inside its own tool dir.

| Export                                                           | Guarantees for you                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeBin({lock?, version?, installRoot?})`                       | THE call rows 88/89 use: returns `{ok:true, path}` with the absolute `<root>/<version>/bin/node`, verified present + executable + digest-matching its install record. Tampered or missing => `{ok:false, reason}` — never a system-node fallback. Works with an EMPTY `PATH`; consults and mutates none.                                                       |
| `nodeChildEnv(base?, installRoot?)`                              | Copy of `base` env with `npm_config_cache` redirected under `~/.swarm` (01d §6.4). PATH copied verbatim — spawn npm as `[dirname(bin), "npm"... ]`-style absolute argv with this env, never by putting Node on PATH.                                                                                                                                           |
| `nodeVersionFromLock(lock)` / `npmCacheDir()` / `nodeToolRoot()` | Pin + path facts, all resolved from the reviewed lock, no defaults.                                                                                                                                                                                                                                                                                            |
| `step.install(ctx, opts?)` / `step.remove(ctx, opts?)`           | Engine-shaped `StepModule` (plus optional seams). Install chains downloaded->verified->installed->configured->healthy; the health gate IS the blueprint check: the private binary's `--version` must equal the pin. Resume-on-valid = zero network; tamper = quarantine-rename + atomic replace from the re-verified tarball. Dry-run writes nothing anywhere. |

Spawning note for ALL step authors: `node:child_process` stays confined to `verify.ts`
(row-82 gate 3c scans all of `src/`); use `Bun.spawnSync` with an argv array and an
absolute-path binary instead — and normalize piped output through `TextDecoder`, because
bun 1.3.14 returns `Buffer` regardless of any encoding option (caught by this row's real run).
Proofs: `bash test/node.proofs.sh` (P5, the ONE authorized real extraction into
`~/.swarm/tools/node/`, needs explicit `R87_REAL=1`).
