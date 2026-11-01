import { createMemo } from "solid-js"
import { createLandedWork } from "@/pages/session/review/landed-work"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createAgentBoardController } from "./home/agent-board-controller"
import { AgentBoardView } from "./home/agent-board-view"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { HomeSetupNotice } from "@/components/home-status-card"
import { useSettingsDialog } from "@/components/settings-dialog"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const board = createAgentBoardController(home, sessions)
  const landedWork = createLandedWork()
  const openSetup = useSettingsDialog("servers")
  // One session, one row: what needs an answer is above, so it does not appear again below.
  const groups = createMemo(() => {
    const waiting = new Set(board.board.needs.map((need) => need.root.id))
    return sessions.data
      .groups()
      .map((group) => ({ ...group, sessions: group.sessions.filter((record) => !waiting.has(record.session.id)) }))
      .filter((group) => group.sessions.length > 0)
  })
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions
            sessions={sessions}
            search={search}
            scroll={scroll}
            board={
              <>
                <HomeSetupNotice onOpen={openSetup} />
                <AgentBoardView board={board} />
              </>
            }
            groups={groups}
            waiting={() => board.board.needs.length > 0}
            landed={(session) => {
              const work = landedWork.get(session.id)
              // Anything said or done in the session since means this line is no longer the last word on it.
              return work && work.at >= session.time.updated ? work.headline : undefined
            }}
            onOpenProject={() => {
              const conn = home.server.focused()
              if (conn) projects.project.choose(conn)
            }}
          />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
