// Row 34b fixture: stands in for Swarm's sidecar starting the built-in datum-studio MCP entry. Run through the
// `<fixture>/Fake.app/Contents/MacOS/Swarm` symlink, so the launcher's parent process is a running "Swarm". It runs
// UNDER_CMD with this process's stdio and exits with its code.
import { spawn } from "node:child_process"

const child = spawn(process.env.UNDER_CMD!, [], { stdio: "inherit" })
child.on("exit", (code) => process.exit(code ?? 1))
process.on("SIGTERM", () => child.kill("SIGTERM"))
