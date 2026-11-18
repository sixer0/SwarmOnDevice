# Spike S4: streaming through a same-origin proxy (THROWAWAY)

Plan step M0-05 (blueprint row 34). Run inside Office by M0-09 (row 38). Not production code: the
real bridge is built in M1+ and follows the register, not this folder.

## Files

| File | What |
|---|---|
| `proxy.ts` | Bun proxy. Serves the pane at `/pane/index.html` and forwards P2, P6, P7, P8 (register §7.3) under `/swarm` to the sidecar, adding Basic auth server-side |
| `pane/index.html`, `pane/main.ts` | Streaming pane on `@opencode-ai/sdk/v2/client`, bundled by the proxy at start (`Bun.build`, browser target) |
| `fake-llm.ts` | Scripted OpenAI-compatible LLM on `127.0.0.1:55318`; streams `PONG` one character every 150 ms. No real model |
| `dev-sidecar.sh` | Starts `fake-llm.ts` and a Swarm dev sidecar (`bun run ./src/index.ts serve` in `packages/opencode`) on `127.0.0.1:55317` with HOME/XDG pinned under `$TMPDIR` |
| `sdk-smoke.ts` | Drives the proxy from Bun with the pane's client library: one complete run, one aborted run |
| `smoke.sh` | The local smoke (no Office). Needs the sandbox bypass (it binds ports) |
| `tsconfig.json` | Typecheck: `./node_modules/.bin/tsgo --noEmit -p test/spikes/s4/tsconfig.json` from `packages/office-addin` |

## Proxy behaviour

- **Env only, refuses without it.** `SWARM_S4_SIDECAR_URL`, `SWARM_S4_SIDECAR_USERNAME`, `SWARM_S4_SIDECAR_PASSWORD`.
  Any missing: prints the missing *names* and exits 2. Values are never printed.
- **Routes.** `POST /swarm/session` (P2), `POST /swarm/session/:id/prompt_async` (P6),
  `POST /swarm/session/:id/abort` (P7), `GET /swarm/event` (P8). Anything else: `404 ROUTE_NOT_ALLOWED`.
  P1, P3, P4, P5 are deliberately not in the spike.
- **P2** accepts only `title` (string, max 200) and `host` (`Word`/`Excel`); any other field
  (including `tools`) gives `400 FIELD_NOT_ALLOWED`. Upstream body is forced to
  `{title, permission: OFFICE_SESSION_RULESET, metadata: {"swarm.origin": "office-addin", "swarm.office.host"?}}`.
- **P6** accepts only `parts`: 1-2 items of exactly `{type: "text", text}`. `tools` and every other field: `400`.
- **P6/P7** only for sessions created through this proxy instance (in-memory set; the production
  bridge does the upstream ownership check of register §7.2 instead).
- **Every `/swarm/*`** needs `X-Swarm-Office: 1` (else `403 CSRF_HEADER_MISSING`). `X-Swarm-Office-Token`
  is not checked: there is no pairing in S4.
- **Directory.** `directory=<SWARM_S4_WORKSPACE>` (default `$TMPDIR/swarm-s4-workspace`, created `0700`) is forced on
  every upstream request; client query strings are dropped.
- **SSE** is passed through as a stream (no buffering), `idleTimeout: 0`, upstream fetch aborted when the client goes.
- **Log**: one line per request, `ISO-time METHOD /path STATUS duration [stream-open|stream-end|stream-cancel]`.
  No query string, headers, bodies or credentials. `SWARM_S4_LOG=<file>` also appends to a file.
- **Origin**: `OPTIONS` and a foreign `Origin` give `403`.
- Binds `127.0.0.1` and `::1` (`SWARM_S4_HOSTNAMES` to override), port `SWARM_S4_PORT` (default `46317`).

## TLS: path contract with spike S1/S2 (row 32)

The proxy does not make certificates. It reads two PEM paths from env:

| Env | Must point at |
|---|---|
| `SWARM_S4_TLS_CERT` | the **`localhost` leaf certificate** PEM produced by the S1/S2 `pkijs` script (under `$TMPDIR`, see `implementation/03_spike_s1_s2.md` for the exact file name) |
| `SWARM_S4_TLS_KEY` | the matching leaf private key PEM |

Both are required unless `SWARM_S4_INSECURE_HTTP=1` (local smoke only; Office needs HTTPS). The CA
must already be trusted by SP-S1 (row 35). The key is read by Bun only, never logged.

## Local smoke (what row 34 ran)

From `packages/office-addin/test/spikes/s4`, with the bundled Bun on `PATH`, and the sandbox bypass:

```sh
export PATH=/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin:$PATH
./smoke.sh
```

Ports: sidecar `55317`, scripted LLM `55318`, proxy `47317` (register test ports; `46317` is not used).
It stops every process it started on exit. The throwaway home `$TMPDIR/swarm-s4-home.*` is left for
inspection; delete it afterwards.

## Dev sidecar by hand

```sh
cd packages/office-addin/test/spikes/s4
source ./dev-sidecar.sh          # sets S4_HOME, S4_SIDECAR_URL, S4_PASSWORD, S4_PIDS; prints nothing secret
# ... later: kill $S4_PIDS; rm -rf "$S4_HOME"
```

It runs, in `packages/opencode`:
`bun run ./src/index.ts serve --hostname 127.0.0.1 --port 55317` with `HOME`, `OPENCODE_TEST_HOME` and
`XDG_{CONFIG,DATA,STATE,CACHE}_HOME` under the throwaway home, `OPENCODE_CONFIG_CONTENT` pointing the
default model at the scripted LLM (`s4/scripted`), `OPENCODE_PURE=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`,
`OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_AUTH_CONTENT={}` and a random `OPENCODE_SERVER_PASSWORD`
(`openssl rand -hex 24`) passed through env only.

## Row 38 (M0-09): running it inside Office

Holds `lock:office-device`. The S1/S2 server also uses `46317`: stop it first.

1. A(B): `source ./dev-sidecar.sh` (scripted model), **or** point at the Swarm dev build's sidecar
   (credentials from its `app-server.env`, 0600, loaded into env without printing) if OQ-T9 /
   `thinker` reachability is being tested. Synthetic prompts only.
2. A(B): start the proxy on 46317 with TLS:

   ```sh
   SWARM_S4_SIDECAR_URL=$S4_SIDECAR_URL SWARM_S4_SIDECAR_USERNAME=opencode SWARM_S4_SIDECAR_PASSWORD=$S4_PASSWORD \
   SWARM_S4_TLS_CERT=<S1 localhost leaf cert> SWARM_S4_TLS_KEY=<S1 localhost leaf key> \
   SWARM_S4_LOG=$S4_HOME/logs/proxy.log bun ./proxy.ts
   ```

3. The pane URL is `https://localhost:46317/pane/index.html`, the same `SourceLocation` as the register
   and the S1/S2 manifests, so the already sideloaded S1/S2 manifest loads this pane. No new manifest.
4. U: open the add-in in Word, click **Connect stream**, then **Send synthetic prompt**
   (`Reply with the word PONG.`). For a longer stream, restart the scripted LLM with
   `SWARM_S4_LLM_REPLY="1 2 3 ... 40"` (or use the SP-S4 prompt against `thinker`). Click **Abort** mid-stream.
5. U: **Copy capture** and paste it into the evidence file. The capture has event types, ms offsets,
   part ids, delta lengths and `hasProviderID`/`hasModelID` booleans; no reply text.
6. A(B): `grep -cF "$S4_PASSWORD" $S4_HOME/logs/proxy.log` = 0; stop proxy, `kill $S4_PIDS`, `rm -rf $S4_HOME`.

## Findings from the local smoke (for SP-S4 / O6 / G7)

- Incremental text event: `message.part.delta` with `properties.field = "text"`, `delta` = the new
  characters, keyed by `partID`/`messageID`. `message.part.updated` carries the full `TextPart` at start and end.
- Assistant `message.updated` carries `providerID` and `modelID` (here `s4` / `scripted`): OI-1 option A input.
- Abort: `session.error`, `session.status`, `session.idle` within ~1 ms of the `abort` 200.
- The SDK's `event.subscribe` opens the HTTP stream lazily, on the first iteration of `stream`. The
  pane therefore starts iterating (Connect) before it sends.
- Instance start noise on `/event`: about 45 `plugin.added` plus `catalog.updated`, `reference.updated`,
  `integration.updated` frames on first connect; the pane must ignore unknown types.
