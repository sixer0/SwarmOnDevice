import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createMediaQuery } from "@solid-primitives/media"
import { type Accessor, createEffect, createMemo, on, onCleanup, onMount, Show, Suspense } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { type HomeProjectSelection, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { createLandedWork } from "@/pages/session/review/landed-work"
import { createAgentBoardController } from "./agent-board-controller"
import { AgentBoardView } from "./agent-board-view"
import { createHomeController } from "./home-controller"
import { focusPaneSearch, shouldCloseOnWindowEscape } from "./home-pane-focus"
import { homePaneScope, routeTab } from "./home-pane-scope"
import { closeHomePane, isChatRoute, setHomePaneRoot, takeHomePaneFocusRequest } from "./home-pane-state"
import { createHomeScrollController } from "./home-scroll-controller"
import { createHomeSessionSearchController } from "./home-session-search-controller"
import { createHomeSessionsController } from "./home-sessions-controller"
import { HomeSessions } from "./home-sessions"

/**
 * Home beside the chat, mounted (lazily) by NewLayout while the pane is open. On the Home route the full Home page
 * shows instead, so the pane closes there. Pushes the chat at md and up; overlays its left side below that.
 */
export function HomePaneHost() {
  const layout = useLayout()
  const chat = createMemo(() => isChatRoute(layout.route()))
  const narrow = createMediaQuery("(max-width: 767px)")
  createEffect(() => {
    if (!chat()) closeHomePane()
  })
  return (
    <Show when={chat()}>
      <Show when={narrow()}>
        {/* The strip of chat left visible beside the overlay: a click there puts the chat back. */}
        <div aria-hidden="true" class="absolute inset-0 z-40" onClick={closeHomePane} />
      </Show>
      <HomePane overlay={narrow()} />
    </Show>
  )
}

/** Esc handling for the pane: `capture` runs on the pane before its children, `keydown` after them. */
export function homePaneEscape(close: () => void) {
  return {
    // Esc in the empty search box has nothing to clear, so it closes the pane before the box blurs itself; focus is
    // still inside the pane then, so closing hands it back to the composer. The Home page's search box is unchanged.
    capture: (event: KeyboardEvent) => {
      const target = event.target
      if (event.key !== "Escape" || event.isComposing) return
      if (!(target instanceof HTMLInputElement) || target.value !== "") return
      event.preventDefault()
      event.stopPropagation()
      close()
    },
    keydown: (event: KeyboardEvent) => {
      // The search box answers Esc first (it clears and blurs), so only an unhandled Esc closes the pane.
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      close()
    },
  }
}

/** The current project's sessions, opened in the chat on click. */
export function HomePane(props: { overlay: boolean }) {
  const layout = useLayout()
  const tabs = useTabs()
  const server = useServer()
  const global = useGlobal()
  const language = useLanguage()
  let root: HTMLElement | undefined

  const currentTab = () => routeTab(layout.route(), tabs.store)
  const scope = createMemo(
    () =>
      homePaneScope({
        route: layout.route(),
        tab: currentTab(),
        info: tabs.info,
        serverKey: server.key,
        projects: (key) => {
          const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
          return conn ? global.ensureServerCtx(conn).projects.list() : []
        },
        sessionDirectory: () => {
          const route = layout.route()
          if (route.type !== "session") return undefined
          const key = route.server ?? server.key
          const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
          return conn
            ? global.ensureServerCtx(conn).sync.session.lineage.peek(route.sessionId)?.session.directory
            : undefined
        },
      }),
    undefined,
    { equals: (a, b) => a?.server === b?.server && a?.directory === b?.directory },
  )

  // Below md the pane covers the chat, so choosing a session (or any other chat) puts the chat back in view.
  createEffect(
    on(
      () => layout.route(),
      () => {
        if (props.overlay) closeHomePane()
      },
      { defer: true },
    ),
  )

  const escape = homePaneEscape(closeHomePane)
  // Esc with nothing focused (for example after Esc in the search box cleared and blurred it) still closes the pane.
  const windowEscape = (event: KeyboardEvent) => {
    if (!shouldCloseOnWindowEscape(event, root)) return
    event.preventDefault()
    closeHomePane()
  }
  let stopFocus: (() => void) | undefined
  onMount(() => {
    if (!root) return
    setHomePaneRoot(root)
    // Capture phase: the pane sees Esc before its search box does (see homePaneEscape).
    root.addEventListener("keydown", escape.capture, true)
    window.addEventListener("keydown", windowEscape)
    // Opened from the keyboard: the search box (the pane itself until the box is there, so Esc already closes it).
    if (takeHomePaneFocusRequest()) stopFocus = focusPaneSearch(root)
  })
  onCleanup(() => {
    root?.removeEventListener("keydown", escape.capture, true)
    window.removeEventListener("keydown", windowEscape)
    stopFocus?.()
    setHomePaneRoot(undefined)
  })

  return (
    <aside
      ref={root}
      tabIndex={-1}
      data-component="home-pane"
      // Typing on a pane row must not be redirected into the chat composer by the session page.
      data-prevent-autofocus
      aria-label={language.t("session.header.sessions.label")}
      class="min-h-0 flex flex-col overflow-hidden bg-v2-background-bg-base outline-none"
      classList={{
        "relative m-2 mr-0 shrink-0 w-[clamp(300px,30%,420px)] rounded-[10px] shadow-[var(--v2-elevation-raised)]":
          !props.overlay,
        "absolute inset-y-0 left-0 z-50 w-[min(360px,calc(100%-56px))] shadow-[var(--v2-elevation-raised)]":
          props.overlay,
      }}
      onKeyDown={escape.keydown}
    >
      <div class="flex shrink-0 items-center justify-between gap-2 px-2 pt-2">
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="normal"
          icon={<IconV2 name="close" />}
          aria-label={language.t("common.close")}
          onClick={closeHomePane}
        />
        <ButtonV2
          type="button"
          variant="ghost-muted"
          size="normal"
          onClick={() => tabs.toggleHome({ home: false, current: currentTab() })}
        >
          {language.t("home.projects")}
        </ButtonV2>
      </div>
      <Show when={scope()} fallback={<p class="px-3 py-6 text-v2-text-text-muted">{language.t("common.loading")}</p>}>
        {/* A query read that suspends hides only the list, not the pane, its close button or its Esc handling. */}
        {(selection) => (
          <Suspense>
            <HomePaneSessions scope={selection} />
          </Suspense>
        )}
      </Show>
    </aside>
  )
}

function HomePaneSessions(props: { scope: Accessor<HomeProjectSelection> }) {
  const home = createHomeController({ scope: props.scope })
  const sessions = createHomeSessionsController(home, { commands: false })
  const search = createHomeSessionSearchController(home, sessions, { commands: false })
  const scroll = createHomeScrollController(sessions.data.groups)
  const board = createAgentBoardController(home, sessions)
  const landedWork = createLandedWork()
  // As on the Home page: what needs an answer is in the board above, so it does not appear again below.
  const groups = createMemo(() => {
    const waiting = new Set(board.board.needs.map((need) => need.root.id))
    return sessions.data
      .groups()
      .map((group) => ({ ...group, sessions: group.sessions.filter((record) => !waiting.has(record.session.id)) }))
      .filter((group) => group.sessions.length > 0)
  })
  return (
    <ScrollView
      class="min-h-0 flex-1 [container-type:size]"
      thumbContainer={scroll.viewport.thumbTrack}
      thumbHoverTarget={scroll.viewport.hoverTarget}
      viewportRef={scroll.viewport.setViewport}
      onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
      onWheel={scroll.viewport.containOuterWheel}
    >
      <div class="flex min-h-full w-full flex-col px-3">
        <HomeSessions
          sessions={sessions}
          search={search}
          scroll={scroll}
          board={<AgentBoardView board={board} />}
          groups={groups}
          waiting={() => board.board.needs.length > 0}
          landed={(session) => {
            const work = landedWork.get(session.id)
            return work && work.at >= session.time.updated ? work.headline : undefined
          }}
        />
      </div>
    </ScrollView>
  )
}
