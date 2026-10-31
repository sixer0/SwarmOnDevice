import { Global } from "@opencode-ai/core/global"
import { mergeRows, nextWaiting, tmuxSegment, whereLabel, age, type FleetRow } from "@opencode-ai/tui/fleet/model"
import { fleetDirectory, jumpToRow, readPeers, tmuxContext } from "@opencode-ai/tui/fleet/registry"
import path from "node:path"
import { cmd } from "./cmd"

const LABEL: Record<FleetRow["state"], string> = { waiting: "NEEDS YOU", failed: "FAILED", running: "RUNNING", done: "FINISHED" }

function rows(): FleetRow[] {
  const peers = readPeers(fleetDirectory(Global.Path.state), { now: Date.now() })
  return mergeRows({ local: [], peers, self: { tmuxSocket: tmuxContext()?.socket } })
}

function table(list: FleetRow[], now: number) {
  const cells = list.map((row) => [
    LABEL[row.state],
    path.basename(row.directory),
    whereLabel(row),
    age(row.since, now),
    row.title,
    row.pending?.label ?? row.activity ?? "",
  ])
  const widths = [0, 1, 2, 3].map((column) => Math.max(...cells.map((cell) => cell[column].length)))
  return cells
    .map((cell) =>
      [...cell.slice(0, 4).map((value, column) => value.padEnd(widths[column])), cell[4], cell[5] ? `  ${cell[5]}` : ""]
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

export const FleetCommand = cmd({
  command: "fleet",
  describe: "show every Swarm agent running on this machine",
  builder: (yargs) =>
    yargs
      .option("tmux", { type: "boolean", describe: "print a tmux status-line segment: #(swarm fleet --tmux)" })
      .option("jump", { type: "boolean", describe: "switch this tmux client to the next agent that needs you" })
      .conflicts("jump", "tmux")
      .epilog(
        [
          "Sees every running swarm on this machine, each in its own terminal or tmux pane.",
          "In tmux.conf:",
          "  set -g status-right '#(swarm fleet --tmux) %H:%M'",
          "  bind-key a run-shell 'swarm fleet --jump'",
          "  set -g monitor-bell on",
        ].join("\n"),
      ),
  handler: async (args) => {
    const list = rows()
    if (args.tmux) {
      process.stdout.write(tmuxSegment(list) + "\n")
      return
    }
    if (args.jump) {
      const here = tmuxContext()
      const reachable = list.filter((row) => row.where.kind === "peer" && row.where.pane)
      // Start after the pane you are looking at, so repeated presses walk through everything blocked.
      const current = reachable.find((row) => row.where.kind === "peer" && row.where.pane === here?.pane && row.state === "waiting")
      const next = nextWaiting(reachable.filter((row) => row.state === "waiting"), current?.key)
      if (!next) {
        process.stdout.write("No other agent needs you\n")
        return
      }
      const result = jumpToRow(fleetDirectory(Global.Path.state), next)
      if (!result.ok) {
        process.stderr.write(result.message + "\n")
        process.exitCode = 1
      }
      return
    }
    if (list.length === 0) {
      process.stdout.write("No Swarm agents are running on this machine.\n")
      return
    }
    process.stdout.write(table(list, Date.now()) + "\n")
  },
})
