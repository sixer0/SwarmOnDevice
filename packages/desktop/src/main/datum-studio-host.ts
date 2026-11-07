// datum-studio-host utility process entry (row 111; Studio spec §3.1). Forked by main after app.whenReady with
// cwd = Res/datum-studio/ (M4). Row 45 adds this file as the electron-vite main input `datum-studio-host`.
import { runStudioHost, type ParentPortLike } from "./datum-studio-host/host-runner"

const port = process.parentPort as ParentPortLike | undefined
if (!port) throw new Error("datum-studio-host parent port unavailable")

runStudioHost(port, () => import("virtual:datum-studio-host"), { onStopped: () => setTimeout(() => process.exit(0), 0) })
