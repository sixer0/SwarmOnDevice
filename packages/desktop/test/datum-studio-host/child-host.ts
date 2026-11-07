// Test fixture (row 111): a stand-in for the datum-studio-host utility process, run as a separate bun process over
// node IPC. It runs the real host runner with the real store bridge (row 109 openHostStore -> row 30 lock + SQLite);
// only the MCP server (row 31, not built yet) and the template source are doubles. Never a network listen.
//
// Lock liveness: the row 30 default accepts only a running */Contents/MacOS/Swarm|Electron (Helper); a bun process is
// neither, so this fixture checks "the PID is running" (kill 0) instead. The comm rule itself is row 30's test.
import { closeHostStore, openHostStore } from "../../../datum-studio/src/store-bridge/index.ts"
import { runStudioHost, type ParentPortLike } from "../../src/main/datum-studio-host/host-runner"
import type { HostMessage, StudioHostModule } from "../../src/main/datum-studio-host/protocol"

const send = process.send?.bind(process)
if (!send) throw new Error("child-host needs an IPC channel")

const port: ParentPortLike = {
  postMessage: (message: HostMessage) => void send(message),
  on: (_event, listener) => void process.on("message", (data) => listener({ data })),
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const mod: StudioHostModule = {
  openHostStore: (root, opts) => openHostStore(root, opts) as never,
  closeHostStore: (store) => closeHostStore(store as never),
  configureTemplateSource: (config) => {
    if (config) port.postMessage({ type: "log", level: "info", source: "fixture.templates", message: "configured", context: { ...config } })
  },
  startStudioHostServer: async (opts) => {
    // Report what the server received without the token itself.
    opts.log("info", "fixture.server", "server started", {
      tokenHexLength: /^[0-9a-f]+$/.test(opts.token) ? opts.token.length : -1,
      hostname: opts.hostname,
      env: {
        DATUM_RENDER_SOCKET: process.env.DATUM_RENDER_SOCKET ?? null,
        DATUM_RENDER_TOKEN_SET: Boolean(process.env.DATUM_RENDER_TOKEN),
        STUDIO_ASSETS_ROOT: process.env.STUDIO_ASSETS_ROOT ?? null,
        STUDIO_WORKSPACE_ROOT: process.env.STUDIO_WORKSPACE_ROOT ?? null,
        STUDIO_VENDOR_ROOT: process.env.STUDIO_VENDOR_ROOT ?? null,
        FIXTURE_SECRET: process.env.FIXTURE_SECRET ?? null,
      },
    })
    return { url: `http://127.0.0.1:47${String(process.pid % 1000).padStart(3, "0")}/mcp`, close: async () => {} }
  },
}

runStudioHost(port, async () => mod, { isLiveHost: isRunning, onStopped: () => setTimeout(() => process.exit(0), 0) })
