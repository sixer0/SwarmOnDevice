# Security

Publisher: PT GSP. This file states how to report a Swarm vulnerability, how PT
GSP handles disclosure, and which builds are supported. There is no hosted
vulnerability platform behind Swarm: no advisory page, no bounty programme, and
no third-party intake form. Reports reach a person by email, and only by email.

## Intake expectations

Send findings a human wrote and reproduced. Bulk machine-generated output is not
triaged: this product is maintained by a small team, and an unreproduced report
costs more reviewer time than it saves.

## Threat model

### Overview

Swarm is an AI coding agent that runs locally on your machine. Its agent has
access to powerful tools, including shell execution, file operations, and web
access.

### No sandbox

Swarm does **not** sandbox the agent. The permission system exists as a UX
feature to help users stay aware of what actions the agent is taking - it prompts
for confirmation before executing commands, writing files, and so on - but it is
not designed to provide security isolation.

If you need true isolation, run Swarm inside a container or a VM.

### Server mode

Server mode is opt-in only. It is protected with HTTP Basic Auth, configured
through `SWARM_SERVER_PASSWORD`, and Swarm's hardening requirement (NR-08) is
that `serve` and `web` refuse to start when no password is set. Securing a server
you have chosen to expose stays the operator's responsibility; anything the
server provides to an authenticated client is expected behaviour, not a
vulnerability.

### What PT GSP assumes while triaging

The desktop app renders arbitrary local files and provider content, so its web
engine is treated as exposed unless a written analysis proves a feature absent.
A finding measured against an older build is re-checked against the newest build
before it is classified.

### Out of scope

| Category                        | Rationale                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------- |
| **Server access when opted in** | If you enable server mode, authenticated API access is expected behaviour        |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                               |
| **LLM provider data handling**  | Data sent to the provider you configure is governed by that provider's policies  |
| **MCP servers you add**         | External MCP servers you configure are outside PT GSP's trust boundary           |
| **Malicious config files**      | Users control their own configuration; modifying it is not an attack vector      |
| **Findings already fixed**      | A report against a superseded build is checked against the current release first |

## Reporting a vulnerability

Report by email to the address below, and only to that address. Do not route a
Swarm report through any other project's advisory page, escalation mailbox, or
security team - including the project Swarm is derived from. Those people do not
maintain Swarm, and a report sent there discloses a Swarm flaw without telling
the party that can fix it.

The contact slot below is defined once, in section 9 of the PT GSP security
process, and filled in one sweep when PT GSP supplies the address:

```
[[SWARM_SECURITY_CONTACT]] = <email address to be supplied by PT GSP>          # placeholder
[[SWARM_SECURITY_PGP]]       = <key fingerprint + keyserver or bundled pubkey> # optional, placeholder
```

While the placeholder is unfilled, Swarm builds stay inside PT GSP: distributing
Swarm outside the company with no working security contact is prohibited (rule
R-15 of the security process).

Put in the report:

- the exact build: `swarm --version`, the release tag (`swarm/1.19.3-r<N>`), and
  the SHA-256 of the artifact from the release handover
- hardware, macOS version, and whether you used the CLI, the TUI, or the desktop
  app
- steps to reproduce against a fresh configuration
- what an attacker gains, and whether real credentials or data were involved
- whether you want credit or anonymity; either is honoured

## Disclosure timing

Summarised from the PT GSP security process (rule R-16); that document holds the
authoritative wording:

- every report gets an acknowledgement within 5 business days
- the item is classified Critical, High, Moderate or Low and the matching rebuild
  SLA starts
- the advisory-list entry is published when the fixing build is handed over, or
  60 calendar days after triage classifies the item, whichever comes first
- Swarm inherits no embargo programme from the upstream project, so these
  timings are PT GSP policy and can be adjusted only by editing that process
  document

## Supported versions

Swarm ships no auto-updater and no update feed. A fix reaches you only when you
reinstall, so "supported" means: you are running the newest build PT GSP has
handed over. Each release carries an advisory list naming what was patched and
what is still open; compare it with your installed build.

| Build                                                                          | Support                                    | Security rebuild commitment                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Newest handed-over build on the current pin (`swarm/1.19.3-r<N>`, highest `N`) | Supported                                  | Critical: triage 1 business day, ship 3. High: triage 2 business days, ship 10. Moderate: folded into the next scheduled release, or 30 business days, whichever comes first. Low: recorded and reviewed at the monthly cycle. |
| Any older build on the same pin                                                | Not supported                              | No rebuilds. Reinstall the newest build; if a flaw is still open there, it is listed as open in the advisory list.                                                                                                             |
| Builds cut from a different upstream pin                                       | Not supported once a newer pin is released | Migration to the newer pin is the fix path.                                                                                                                                                                                    |

Reinstall steps, the signed `SHA256SUMS` handover, and the quarantine wording are
part of the PT GSP release package; follow them rather than any download link.
