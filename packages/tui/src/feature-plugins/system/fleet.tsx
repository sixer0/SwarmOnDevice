/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { age, GROUP_TITLE, toLines, windowLines, type FleetLine, type FleetRow, type FleetState } from "../../fleet/model"
import { fleetDirectory, jumpToRow } from "../../fleet/registry"
import { createFleetState, type FleetStore } from "../../fleet/state"
import { useBindings, useCommandShortcut } from "../../keymap"
import { Toast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"

const ROUTE = "fleet"
const SIDE_BY_SIDE_WIDTH = 100
/** Under this a pane has no room for detail: the blocked row already shows the command, and enter shows the rest. */
const STACKED_DETAIL_HEIGHT = 24
const STACKED_DETAIL_ROWS = 10

const GLYPH: Record<FleetState, string> = { waiting: "▲", failed: "✕", running: "●", done: "✓" }

const projectName = (directory: string) => path.basename(directory) || directory

function FleetBoard(props: { api: TuiPluginApi; fleet: FleetStore }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const rows = props.fleet.rows
  const lines = createMemo(() => toLines(rows()))
  const sideBySide = createMemo(() => dimensions().width >= SIDE_BY_SIDE_WIDTH)
  const listWidth = createMemo(() => (sideBySide() ? Math.floor(dimensions().width * 0.52) : dimensions().width))
  const detailRows = createMemo(() => {
    if (sideBySide() || dimensions().height < STACKED_DETAIL_HEIGHT) return 0
    return STACKED_DETAIL_ROWS
  })
  const view = createMemo(() => windowLines(lines(), selectedKey(), Math.max(2, dimensions().height - 3 - detailRows())))
  const selected = createMemo(() => rows().find((row) => row.key === selectedKey()))
  const stateColor = (state: FleetState): RGBA => {
    if (state === "waiting") return theme.warning
    if (state === "failed") return theme.error
    if (state === "running") return theme.primary
    return theme.success
  }

  const clock = setInterval(() => setNow(Date.now()), 5000)
  onCleanup(() => clearInterval(clock))

  // Until the person picks a row, stay on the top one: whoever has waited longest, even if it just arrived.
  // After that, when the selected agent leaves (it was just answered), the same position is the next one.
  let picked = false
  let lastIndex = 0
  createEffect(() => {
    const list = rows()
    setNow(Date.now())
    if (!picked) return setSelectedKey(list[0]?.key)
    const index = list.findIndex((row) => row.key === selectedKey())
    if (index >= 0) {
      lastIndex = index
      return
    }
    setSelectedKey(list[Math.min(lastIndex, list.length - 1)]?.key)
  })

  const pick = (key: string | undefined) => {
    picked = true
    setSelectedKey(key)
  }

  const move = (delta: number) => {
    const list = rows()
    if (list.length === 0) return
    const index = list.findIndex((row) => row.key === selectedKey())
    pick(list[Math.max(0, Math.min(list.length - 1, index + delta))].key)
  }

  const send = (row: FleetRow, id: string, request: () => Promise<unknown>) => {
    if (row.where.kind !== "here") return
    props.fleet.hide(id)
    request()
      .then(() => props.fleet.settled(id))
      .catch((error: unknown) => {
        props.fleet.unhide(id)
        props.api.ui.toast({ variant: "error", message: `Could not send that answer: ${errorMessage(error)}` })
      })
  }

  const replyPermission = (reply: "once" | "reject") => {
    const row = selected()
    if (row?.pending?.kind !== "permission") return
    const requestID = row.pending.id
    send(row, requestID, () =>
      props.api.client.permission.reply({ requestID, directory: row.directory, reply }, { throwOnError: true }),
    )
  }

  const answer = (index: number) => {
    const row = selected()
    if (row?.pending?.kind !== "question" || !row.pending.answerable) return
    const option = row.pending.options[index]
    if (!option) return
    const requestID = row.pending.id
    send(row, requestID, () =>
      props.api.client.question.reply({ requestID, directory: row.directory, answers: [[option]] }, { throwOnError: true }),
    )
  }

  const enter = () => {
    const row = selected()
    if (!row) return
    if (row.where.kind === "here") return props.api.route.navigate("session", { sessionID: row.sessionID })
    const result = jumpToRow(fleetDirectory(Global.Path.state), row)
    if (!result.ok) props.api.ui.toast({ variant: "warning", message: result.message })
  }

  const back = () => {
    const current = props.api.route.current
    const params = "params" in current ? (current.params as Record<string, unknown> | undefined) : undefined
    const previous = params?.returnRoute as { name?: string; params?: Record<string, unknown> } | undefined
    props.api.route.navigate(previous?.name ?? "home", previous?.params)
  }

  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  useBindings(() => ({
    commands: [
      { name: "fleet.down", title: "Next agent", run: () => move(1) },
      { name: "fleet.up", title: "Previous agent", run: () => move(-1) },
      { name: "fleet.enter", title: "Open this agent", run: enter },
      { name: "fleet.allow", title: "Allow once", run: () => replyPermission("once") },
      { name: "fleet.deny", title: "Deny", run: () => replyPermission("reject") },
      { name: "fleet.back", title: "Back", run: back },
      ...numbers.map((number) => ({
        name: `fleet.answer.${number}`,
        title: `Answer with option ${number}`,
        run: () => answer(number - 1),
      })),
    ].map((command) => ({ ...command, category: "Fleet" })),
    bindings: [
      { key: "j,down", cmd: "fleet.down", desc: "Next agent" },
      { key: "k,up", cmd: "fleet.up", desc: "Previous agent" },
      { key: "return", cmd: "fleet.enter", desc: "Open this agent" },
      { key: "a", cmd: "fleet.allow", desc: "Allow once" },
      { key: "d", cmd: "fleet.deny", desc: "Deny" },
      { key: "q,escape", cmd: "fleet.back", desc: "Back" },
      ...numbers.map((number) => ({
        key: String(number),
        cmd: `fleet.answer.${number}`,
        desc: `Answer with option ${number}`,
      })),
    ],
  }))

  const Row = (rowProps: { row: FleetRow }) => {
    const isSelected = createMemo(() => selectedKey() === rowProps.row.key)
    const right = createMemo(() => {
      const pane = rowProps.row.where.kind === "peer" ? rowProps.row.where.pane : undefined
      return [projectName(rowProps.row.directory), pane, age(rowProps.row.since, now())].filter(Boolean).join("  ")
    })
    return (
      <box
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={isSelected() ? theme.backgroundElement : undefined}
        onMouseUp={() => pick(rowProps.row.key)}
      >
        <box flexDirection="row" height={1} justifyContent="space-between">
          <text wrapMode="none" fg={theme.text}>
            <span style={{ fg: stateColor(rowProps.row.state) }}>{GLYPH[rowProps.row.state]} </span>
            {Locale.truncate(rowProps.row.title, Math.max(8, listWidth() - 5 - right().length))}
          </text>
          <text wrapMode="none" fg={theme.textMuted}>
            {right()}
          </text>
        </box>
        <Show when={rowProps.row.pending} keyed>
          {(pending) => (
            <box height={1} paddingLeft={2}>
              <text wrapMode="none" fg={theme.warning}>
                {Locale.truncate(pending.label, Math.max(8, listWidth() - 5))}
              </text>
            </box>
          )}
        </Show>
      </box>
    )
  }

  const Line = (lineProps: { line: FleetLine }) => (
    <Switch>
      <Match when={lineProps.line.type === "gap"}>
        <box height={1} flexShrink={0} />
      </Match>
      <Match when={lineProps.line.type === "header" && lineProps.line} keyed>
        {(header) => (
          <box height={1} flexShrink={0} paddingLeft={1}>
            <text wrapMode="none" fg={stateColor(header.state)} attributes={TextAttributes.BOLD}>
              {GROUP_TITLE[header.state]}
              <span style={{ fg: theme.textMuted }}> {header.count}</span>
            </text>
          </box>
        )}
      </Match>
      <Match when={lineProps.line.type === "row" && lineProps.line} keyed>
        {(line) => <Row row={line.row} />}
      </Match>
    </Switch>
  )

  const Detail = (detailProps: { row: FleetRow }) => (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1} minHeight={0} overflow="hidden">
      <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word" flexShrink={0}>
        {detailProps.row.title}
      </text>
      <Show when={detailProps.row.pending} keyed>
        {(pending) => (
          <box flexDirection="column" paddingTop={1} flexShrink={0}>
            <text fg={theme.warning} wrapMode="word">
              {pending.label}
            </text>
            <For each={pending.kind === "permission" ? pending.detail : []}>
              {(line) => (
                <text
                  wrapMode="none"
                  fg={line.startsWith("+") ? theme.diffAdded : line.startsWith("-") ? theme.diffRemoved : theme.textMuted}
                >
                  {line}
                </text>
              )}
            </For>
            <For each={pending.kind === "question" ? pending.options : []}>
              {(option, index) => (
                <text wrapMode="none" fg={theme.text}>
                  <span style={{ fg: theme.primary }}>{index() + 1} </span>
                  {option}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={detailProps.row.error}>
        <box paddingTop={1} flexShrink={0}>
          <text fg={theme.error} wrapMode="word">
            {detailProps.row.error}
          </text>
        </box>
      </Show>
      <box paddingTop={1} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <For each={detailProps.row.tail}>
          {(line) => (
            <text fg={line.startsWith("✕") ? theme.error : theme.textMuted} wrapMode="none" flexShrink={0}>
              {line}
            </text>
          )}
        </For>
      </box>
    </box>
  )

  const hints = createMemo(() => {
    const row = selected()
    if (!row) return "q back"
    if (row.where.kind === "peer") {
      if (row.where.pane) return `enter go to pane ${row.where.pane}   q back`
      return "running in another terminal   q back"
    }
    if (row.pending?.kind === "permission") return "a allow   d deny   enter open   q back"
    if (row.pending?.kind === "question" && row.pending.answerable) {
      return `1-${Math.min(9, row.pending.options.length)} answer   enter open   q back`
    }
    return "enter open   q back"
  })

  return (
    <box
      position="absolute"
      zIndex={2400}
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      flexDirection="column"
    >
      <Show when={props.fleet.error()}>
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text wrapMode="none" fg={theme.error}>
            {Locale.truncate(`Could not reach the Swarm server, retrying (${props.fleet.error()})`, dimensions().width - 2)}
          </text>
        </box>
      </Show>
      <box flexGrow={1} minHeight={0} flexDirection={sideBySide() ? "row" : "column"}>
        <box width={listWidth()} flexGrow={sideBySide() ? 0 : 1} minHeight={0} flexShrink={0} flexDirection="column" paddingTop={1} overflow="hidden">
          <Show
            when={rows().length > 0}
            fallback={
              <box paddingLeft={2}>
                <text fg={theme.textMuted}>
                  {props.fleet.status() === "loading" ? "Looking for agents..." : "No agents running on this machine."}
                </text>
              </box>
            }
          >
            <For each={view().lines}>{(line) => <Line line={line} />}</For>
          </Show>
        </box>
        <Show when={(sideBySide() || detailRows() > 0) && selected()} keyed>
          {(row) => (
            <box
              flexGrow={1}
              minHeight={0}
              height={sideBySide() ? undefined : detailRows()}
              flexShrink={sideBySide() ? 1 : 0}
              border={sideBySide() ? ["left"] : ["top"]}
              borderColor={theme.border}
              paddingTop={sideBySide() ? 1 : 0}
              overflow="hidden"
            >
              <Detail row={row} />
            </box>
          )}
        </Show>
      </box>
      <box height={1} flexShrink={0} paddingLeft={1}>
        <text wrapMode="none" fg={theme.textMuted}>
          {hints()}
        </text>
      </box>
      <Toast />
    </box>
  )
}

/** One line under whatever you are doing, only while another agent is stuck on you. */
function FleetStrip(props: { api: TuiPluginApi; fleet: FleetStore }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const shortcut = useCommandShortcut("fleet.open")
  const others = createMemo(() => {
    const route = props.api.route.current
    if (route.name === ROUTE) return []
    const current = route.name === "session" ? route.params?.sessionID : undefined
    return props.fleet.rows().filter((row) => row.state === "waiting" && row.sessionID !== current)
  })
  const message = createMemo(() => {
    const count = others().length
    return count === 1 ? "1 other agent needs you" : `${count} other agents need you`
  })
  return (
    <Show when={others().length > 0}>
      <box
        height={1}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
        onMouseUp={() => props.api.keymap.dispatchCommand("fleet.open")}
      >
        <text wrapMode="none" fg={theme.warning}>
          {Locale.truncate(`▲ ${message()}`, Math.max(10, dimensions().width - shortcut().length - 4))}
        </text>
        <text wrapMode="none" fg={theme.textMuted}>
          {shortcut()}
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const fleet = createFleetState({
    client: api.client,
    event: api.event,
    state: api.state,
    onNewlyBlocked() {
      // Sounds play on the machine Swarm runs on and OSC notifications die inside tmux. A bell crosses SSH and makes tmux
      // flag this window in the status bar, which is exactly where someone with five windows is looking. On by default
      // only there, where the multiplexer owns what a bell does (`bell-action none` silences it); elsewhere it can beep.
      const multiplexed = process.env.TMUX !== undefined || process.env.STY !== undefined
      if ((multiplexed || api.tuiConfig.attention.enabled) && process.stdout.isTTY) process.stdout.write("\x07")
    },
    onGoto(sessionID) {
      api.route.navigate("session", { sessionID })
    },
  })
  api.lifecycle.onDispose(() => fleet.dispose())

  api.route.register([{ name: ROUTE, render: () => <FleetBoard api={api} fleet={fleet} /> }])

  api.keymap.registerLayer({
    commands: [
      {
        name: "fleet.open",
        title: "Show every agent on this machine",
        category: "Session",
        slashName: "fleet",
        namespace: "palette",
        run() {
          const current = api.route.current
          if (current.name !== ROUTE) api.route.navigate(ROUTE, { returnRoute: current })
          api.ui.dialog.clear()
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("fleet", ["fleet.open"]),
  })

  api.slots.register({
    slots: {
      app_bottom() {
        return <FleetStrip api={api} fleet={fleet} />
      },
    },
  })
}

const plugin = {
  id: "internal:fleet",
  tui,
}

export default plugin
