# Tool health: read what Swarm found and ask for a re-check

Use this when a task depends on a local tool that may be down, when a tool call fails with a connection error, or when the person asks whether Swarm's tools are running. The local tools are web search, web fetch, the container runtime under them, the DATUM render bridge, the diagram layout runtime, and any tools the person registered, such as a local image service.

The Swarm desktop app owns tool health. It checks the tools and starts them again. You read what it found, ask it to check again, and tell the person. Swarm never installs a tool on its own, and neither do you.

## 1. What Swarm checks

At every launch the desktop app checks each tool once, in the background. The check does not slow the start, and it does not poll afterwards.

| id | Tool | Healthy when | Swarm starts it again |
|---|---|---|---|
| `runtime` | Container runtime (the colima VM `swarm`). macOS only | Docker answers on the VM's socket | yes |
| `searxng` | Web search (SearXNG). macOS only, needs `runtime` | `http://127.0.0.1:9021/` answers 200-399 | yes |
| `firecrawl` | Web fetch (Firecrawl). macOS only, needs `runtime` | `http://127.0.0.1:9022/` answers 200-399, 401 or 403 (it sits behind an auth proxy) | yes |
| `render-bridge` | DATUM render bridge, inside the app | it answers on its socket | yes, at the same address, so running sessions keep working |
| `layout-runtime` | Diagram layout runtime (ELK), shipped with the app | its bundle file is present | no. A missing file needs a reinstall or the Swarm update applied again |

Swarm also checks the person's own entries in `~/.config/swarm/tool-health.json` in the same way. `flux3` is the person's own entry, not one of Swarm's tools. It names a local FLUX image service on a machine where the person registered one. On a machine without that entry there is no image service, and the `flux3-image-gen` skill explains how to continue without it. For FLUX, healthy means HTTP 200 with `"weights_downloaded": true`. `model_loaded: false` is normal before the first image.

Swarm starts a dead tool again only when all of these hold:
- it is installed;
- it was seen running before (the two internal tools: earlier in this launch);
- its `consent` is `auto`;
- it has not already been started again once in this launch.

Starts run one at a time. A start only starts what already exists. It never installs, never recreates containers and never downloads anything.

## 2. Read the status

Read `~/.swarm/health/state.json`. Reading it is always allowed. The desktop app is its only writer.

```
{"version":1,"updatedAt":1763000000000,"appVersion":"1.2.6","components":{"searxng":{"lastStatus":"revived","reason":"REVIVED","detail":"compose start ok; GET http://127.0.0.1:9021/ -> 200","lastCheckedAt":1763000000000,"lastHealthyAt":1763000000000,"source":"shipped"}}}
```

If the file or the `~/.swarm/health/` folder is missing, the desktop app has not run a health check. This happens in a terminal-only session or with a Swarm older than 1.2.6. Say so, and do not create them. An id with no record was not checked. Either it does not run on this platform, or it is set to `"startup": "off"`.

| `lastStatus` | Meaning | What you do |
|---|---|---|
| `healthy` | Running. For `render-bridge`, detail `busy` means a long render is ahead in its queue, which is fine | Use it |
| `revived` | It was down, and Swarm started it again | Use it |
| `skipped_not_installed` | Not installed, so Swarm did not start it | Tell the person, and continue without it |
| `skipped_never_healthy` | Never seen running, so Swarm did not start it | Tell the person to start it once themselves. After that, Swarm keeps it running |
| `dead` | Down and not started | Read `reason` below |
| `revive_failed` | Swarm tried to start it, and it is still down | Read `reason`. Ask for at most one re-check |

"Degraded" in other skills means an optional tool that is neither `healthy` nor `revived`. Carry on without it and say what is missing.

`reason` and `detail` say why. Tell the person what is in the right-hand column:

| `reason` | What to tell the person |
|---|---|
| `OK` | The tool is running |
| `REVIVED` | It was down and has been started again |
| `NOT_INSTALLED` | It is not installed. Swarm's own tools are set up from Settings > Tools |
| `NEVER_HEALTHY` | It has never been seen running. Start it once yourself, and Swarm keeps it running after that |
| `CONSENT_MANUAL` | It is down and set to start only when the person asks. Choose **Re-check Tools** in the Swarm app menu |
| `REVIVE_LIMIT` | It went down again after one restart in this session. Swarm will not keep restarting it. Re-check once, or look at the Swarm log |
| `REQUIRES_DOWN` | It needs another tool that is down (named in `detail`, usually `runtime`). Fix that tool first |
| `HTTP_UNREACHABLE` | Nothing answers at its address (refused or timed out) |
| `HTTP_STATUS` | It answered with an unexpected status (in `detail`). For FLUX, 503 means the model weights are missing |
| `HTTP_HOST_REFUSED` | It refused the host name (403). Its URL must use 127.0.0.1 or localhost |
| `HTTP_BODY_MISMATCH` | It answered, but not ready. For FLUX, `weights_downloaded` is false: the weights are missing |
| `SOCKET_UNREACHABLE` | The container runtime does not answer on its socket. The VM is stopped |
| `FILE_MISSING` | A file the app ships is missing. Swarm cannot repair this itself. Reinstall, or apply the Swarm update again |
| `BRIDGE_NOT_STARTED` | The render bridge did not start with Swarm, so renders fail. Quit and reopen Swarm |
| `BRIDGE_SOCKET_GONE`, `BRIDGE_BAD_REPLY` | The render bridge stopped answering. Swarm restarts it at the same address. If it stays down, quit and reopen Swarm |
| `SETUP_BUSY` | Swarm's tool setup was running, so nothing was started. Re-check when the setup has finished |
| `SETUP_NO_START_VERB` | This Swarm build's setup helper cannot start tools. Update Swarm |
| `START_NOT_INSTALLED` | Swarm's setup does not record it as installed, so it was not started. See Settings > Tools |
| `RUNTIME_PROFILE_MISSING` | The runtime profile `swarm` does not exist. Starting it would create a new VM, which Swarm does not do on its own. Run the Tools setup |
| `START_CONTAINERS_MISSING` | Its containers no longer exist. Swarm only starts existing containers. Rebuild them from Settings > Tools |
| `REVIVE_EXIT` | The start command failed (first line in `detail`) |
| `REVIVE_TIMEOUT` | It was started but did not become healthy in time |

These codes appear only in the Swarm log, never as a status. They are about the person's `tool-health.json` or a re-check request: `USER_REGISTRY_UNSAFE` (the file was ignored: it must belong to the person, must not be writable by others, and must be at most 64 KiB), `USER_REGISTRY_INVALID` (not valid JSON), `PROBE_URL_NOT_LOOPBACK`, `REVIVE_BUILTIN_IN_USER_FILE`, `SHIPPED_FIELD_LOCKED`, `ENTRY_INVALID` (one entry, or a re-check request, was ignored), `WATCHED_FILE_CHANGED` (a file the entry watches changed since it was registered; Swarm warned and still started it).

## 3. Check a tool yourself (interactive sessions only)

Loopback `curl` probes are for interactive sessions only. In autonomous mode they are held. Use `state.json` and a re-check instead.

```
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9021/
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9022/
```

Judge the codes as in the table in section 1. For one of the person's entries, call the probe URL from its entry and check the keys it lists. Only call 127.0.0.1 or localhost, and never set a Host header. Do not send a search query to test web search, because that sends a real query out. `runtime`, `render-bridge` and `layout-runtime` have no probe you can run. Read their status.

## 4. Ask for a re-check

Write `~/.swarm/health/recheck.json` with your file-write tool:

```json
{"ids":["searxng","firecrawl"],"requestedAt":1763000000000}
```

The request is used only when it follows these rules:
- It is a JSON object with only `ids` and `requestedAt`. `requestedAt` is optional: the current time in milliseconds.
- `ids` is a non-empty list of ids from section 1 or from the person's entries. One unknown or misspelt id makes the desktop ignore the whole request. Leave `ids` out to check every tool.
- It is a plain file of at most 4 KiB, never a link.

The write is outside the project, so the person may be asked to allow it. If the write is refused or held, for example in autonomous mode, do not try another way. Tell the person to choose **Re-check Tools** in the Swarm app menu.

After the write:
1. Note `updatedAt` in `state.json` before you write.
2. The desktop app takes the file and removes it. One write is one request. Do not write it again while it is waiting.
3. Re-read `state.json` every 10-15 s. The pass is done when `updatedAt` is newer and the id's `lastCheckedAt` is newer. Allow up to: `render-bridge` 15 s, `searxng` 60 s, `firecrawl` 90 s, `runtime` 180 s, a person's entry its `reviveTimeoutMs` (default 30 s). Add 180 s when the web tools wait for `runtime`.
4. If the file is still there after that time, the desktop app is not taking requests. Either the session is terminal-only, the build is older, or Swarm is still finishing its own startup check. Tell the person and stop. If the file is gone but `updatedAt` did not change, the request was ignored. Check it once against the rules above, and do not loop.

What a re-check does: it checks the named tools. It starts again only the `consent: "auto"` tools that are installed and were seen running before. It grants one more start per named tool, and starts of the same tool are at least 30 s apart. A re-check you request never starts a `consent: "manual"` tool. That tool stays `dead` with `CONSENT_MANUAL`. Only the person can start it, by choosing **Re-check Tools** in the Swarm app menu (macOS). Ask for one re-check per tool per task.

## 5. Never

- Never install, repair, update or remove a tool, its model or its containers. Swarm never installs a tool on its own. When something is not installed, tell the person that it is not installed, and stop that part of the work.
- Never start, stop or restart a tool yourself. Do not run swarm-setup, colima, docker, launchctl, a service manager or a package manager for it. The desktop app is the only place that starts tools.
- Never write `~/.config/swarm/tool-health.json` or `~/.swarm/health/state.json`, in any mode. The only file you may write here is `recheck.json`.
- Never use a re-check to start a `consent: "manual"` tool. Never propose changing a tool's `consent` to get around it.
- Only probe 127.0.0.1 or localhost, and never set a Host header.
- Never put a password, key or other credential in a request, a message or a proposed entry.

## 6. Tell the person

Name the tool by its label and id, give the status and reason in plain words, and say what they can do. Then continue the rest of the task. An optional tool that is down never stops the whole task. List what was skipped in your final message.

Example: "Web search (SearXNG, `searxng`) is down. Swarm tried to start it and it did not come back in time (`revive_failed`, `REVIVE_TIMEOUT`). I continued without web search. To try again, choose Re-check Tools in the Swarm app menu. If it stays down, check Settings > Tools."

## 7. Changing or adding entries: propose, never write

`~/.config/swarm/tool-health.json` is the person's list of what Swarm checks and starts at every launch. A start command written there runs without asking. So you never write it: propose the entry in your final message and let the person add it.

- Turn a tool off: `"startup": "off"`. Require the person for every start: `"consent": "manual"`. For Swarm's five tools, only `startup`, `consent`, `reviveTimeoutMs` and `probe.timeoutMs` can be changed. Other fields are ignored.
- A new tool: check it first (section 3) and propose it only after a healthy answer. The probe is an `http` probe on 127.0.0.1 or localhost, or a `file` probe. A `revive` is an absolute program path plus its arguments, with no shell, no `~` and no `$VAR`. Leave `revive` out when you do not know how the tool was started. Swarm then only checks it.

```
{"components":{"my-service":{"label":"My local service","probe":{"kind":"http","url":"http://127.0.0.1:8080/health","expectStatus":200},"startup":"probe","consent":"manual"}}}
```
