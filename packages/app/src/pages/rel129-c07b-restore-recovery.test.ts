import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import * as bootstrap from "@/context/global-sync/bootstrap"
import type { State } from "@/context/global-sync/types"
import type { DirectoryCheck } from "@/context/platform"
import { ServerScope } from "@/utils/server-scope"
import { createFolderMissingNotice } from "./layout/folder-missing"

// 1.2.9 row 55a (AC-C07b, N9-135). A file sat at the Default Project path at launch: every load of that directory
// failed (row 55 now answers 400 LOCATION_NOT_FOLDER instead of 500), and the folder-missing toast showed. The person
// put the folder back and pressed Restore. At d4282fcfd8 Restore only re-checked the path and called `onOpen`; the
// failed load was never run again in that app run:
// - the per-server QueryClient (`context/global.tsx`, `refetchOnMount: false`) keeps each failed query of the directory
//   in its error state, so a component mounting after Restore reads the launch-time failure again;
// - `bootstrapDirectory` leaves a failed child store at status "partial", and `child()` re-loads only at "loading".
// Green: Restore with the folder back resets that directory's failed queries and re-runs its load before `onOpen`.
// Other directories keep their state. No new panel, key or button. Synthetic paths; the check is injected.
// Counts and booleans only (C77).

const SCOPE = ServerScope.local
const DIR = "/syn129-c07b/Default Project"
const OTHER = "/syn129-c07b/Other"

const reloadFailedDirectory = (bootstrap as Record<string, unknown>).reloadFailedDirectory as
  | ((input: {
      queryClient: QueryClient
      scope: ServerScope
      directory: string
      child?: ReturnType<typeof createStore<State>>
      bootstrap?: (directory: string) => Promise<void> | void
    }) => Promise<boolean>)
  | undefined

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  // The app's QueryClient defaults (context/global.tsx); retry off so a failure settles at once.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnReconnect: false, refetchOnMount: false, refetchOnWindowFocus: false },
    },
  })
  const present = new Set<string>([OTHER])
  const calls = new Map<string, number>([
    [DIR, 0],
    [OTHER, 0],
  ])
  const boots: string[] = []
  const order: string[] = []
  const reloads: string[] = []
  const stores = new Map([
    [DIR, createStore({ status: "loading" } as State)],
    [OTHER, createStore({ status: "loading" } as State)],
  ])

  const pathQuery = (directory: string) => ({
    queryKey: [SCOPE, directory, "path"] as const,
    queryFn: async () => {
      calls.set(directory, (calls.get(directory) ?? 0) + 1)
      if (!present.has(directory)) throw { name: "LOCATION_NOT_FOLDER", status: 400 }
      return { directory }
    },
  })

  // A mounted reader of the directory's path (the child store's `useQuery`), as at launch.
  const mount = (directory: string) => {
    const observer = new QueryObserver(queryClient, pathQuery(directory))
    const stop = observer.subscribe(() => {})
    return { observer, stop }
  }

  // bootstrapDirectory at launch: the failed directory stays "partial", a loaded one turns "complete".
  const launchLoad = (directory: string) => {
    const [store, setStore] = stores.get(directory)!
    setStore("status", present.has(directory) ? "complete" : "partial")
    return store
  }

  const notice = createFolderMissingNotice({
    check: () => async (path: string): Promise<DirectoryCheck> => (present.has(path) ? "exists" : "missing"),
    recreate: () => undefined,
    stored: () => true,
    t: (key) => key,
    choose: () => {},
    // The server sync's reloadDirectory (server-sync.tsx), modelled with the same helper and stores.
    reload: async (directory: string) => {
      reloads.push(directory)
      order.push("reload")
      await reloadFailedDirectory?.({
        queryClient,
        scope: SCOPE,
        directory,
        child: stores.get(directory),
        bootstrap: (next) => {
          boots.push(next)
          launchLoad(next)
        },
      })
    },
  } as Parameters<typeof createFolderMissingNotice>[0])

  return { queryClient, present, calls, boots, order, reloads, stores, mount, launchLoad, notice }
}

describe("AC-C07b Restore re-loads a directory whose first load failed", () => {
  test("with the folder back, Restore re-runs the failed load before opening; another directory is untouched", async () => {
    const s = setup()
    const dirReader = s.mount(DIR)
    const otherReader = s.mount(OTHER)
    await flush()
    expect(s.queryClient.getQueryState([SCOPE, DIR, "path"])?.status === "error").toBe(true)
    expect(s.queryClient.getQueryState([SCOPE, OTHER, "path"])?.status === "success").toBe(true)
    expect(s.launchLoad(DIR).status === "partial").toBe(true)
    expect(s.launchLoad(OTHER).status === "complete").toBe(true)

    // Start-up: the toast shows for the path, nothing opens.
    expect(await s.notice.notice(DIR, () => s.order.push("open"))).toBe(true)

    // The person puts the folder back and presses Restore.
    s.present.add(DIR)
    const opened = await s.notice.open(DIR, () => s.order.push("open"))
    await flush()
    await flush()

    expect(opened).toBe(true)
    // The defect at d4282fcfd8: the reader mounted at launch still holds the launch-time failure, and the store
    // stays "partial" (never re-loaded).
    expect(dirReader.observer.getCurrentResult().isError).toBe(false)
    expect(s.stores.get(DIR)![0].status === "partial").toBe(false)
    expect(s.calls.get(DIR)).toBe(2)
    expect(s.queryClient.getQueryState([SCOPE, DIR, "path"])?.status === "success").toBe(true)
    expect(s.order.join(",")).toBe("reload,open")
    expect(s.reloads.length).toBe(1)
    expect(s.boots.length).toBe(1)
    expect(s.boots[0] === DIR).toBe(true)
    expect(s.stores.get(DIR)![0].status === "complete").toBe(true)

    // The other directory: not fetched again, store unchanged, not re-loaded.
    expect(s.calls.get(OTHER)).toBe(1)
    expect(s.stores.get(OTHER)![0].status === "complete").toBe(true)
    expect(s.boots.includes(OTHER)).toBe(false)
    expect(otherReader.observer.getCurrentResult().isSuccess).toBe(true)
    dirReader.stop()
    otherReader.stop()
  })

  // CHAR (green at d4282fcfd8 too): a reader that mounts only after Restore refetches the failed query by itself
  // (retryOnMount), so the stuck readers are the ones mounted at launch (the child store's queries, test above).
  test("a reader that mounts after Restore gets the fresh load, not the launch-time failure", async () => {
    const s = setup()
    const launch = s.mount(DIR)
    await flush()
    s.launchLoad(DIR)
    launch.stop()
    await s.notice.notice(DIR, () => {})
    s.present.add(DIR)
    // The page Restore opens mounts its reader as part of onOpen (refetchOnMount: false).
    let reader: ReturnType<typeof s.mount> | undefined
    await s.notice.open(DIR, () => {
      reader = s.mount(DIR)
    })
    await flush()
    await flush()
    expect(reader !== undefined).toBe(true)
    expect(reader!.observer.getCurrentResult().isError).toBe(false)
    expect(reader!.observer.getCurrentResult().isSuccess).toBe(true)
    reader!.stop()
  })

  test("Restore works a second time in the same run", async () => {
    const s = setup()
    const reader = s.mount(DIR)
    await flush()
    s.launchLoad(DIR)
    for (const round of [1, 2]) {
      if (round === 2) {
        // The file is back at the path: the next load fails again.
        s.present.delete(DIR)
        await s.queryClient.refetchQueries({ queryKey: [SCOPE, DIR, "path"] })
        s.launchLoad(DIR)
        expect(s.queryClient.getQueryState([SCOPE, DIR, "path"])?.status === "error").toBe(true)
      }
      expect(await s.notice.notice(DIR, () => {})).toBe(true)
      s.present.add(DIR)
      expect(await s.notice.open(DIR, () => {})).toBe(true)
      await flush()
      await flush()
      expect(s.reloads.length).toBe(round)
      expect(s.queryClient.getQueryState([SCOPE, DIR, "path"])?.status === "success").toBe(true)
      expect(s.stores.get(DIR)![0].status === "complete").toBe(true)
    }
    reader.stop()
  })

  test("opening a folder this window never saw missing does not re-load anything", async () => {
    const s = setup()
    const reader = s.mount(OTHER)
    await flush()
    s.launchLoad(OTHER)
    expect(await s.notice.open(OTHER, () => {})).toBe(true)
    await flush()
    expect(s.reloads.length).toBe(0)
    expect(s.calls.get(OTHER)).toBe(1)
    reader.stop()
  })
})

describe("AC-C07b wiring: both layouts pass the server sync's reload; no new panel", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")

  test("the server sync exposes reloadDirectory through the shared helper", () => {
    const source = read("../context/server-sync.tsx")
    expect(source.includes("reloadDirectory")).toBe(true)
    expect(source.includes("reloadFailedDirectory(")).toBe(true)
  })

  test("the new and the legacy layout give their notice the reload", () => {
    expect(read("./layout-new.tsx").includes("reload: (directory) => serverSync().reloadDirectory(directory)")).toBe(
      true,
    )
    expect(read("./layout.tsx").includes("reload: (directory) => serverSync().reloadDirectory(directory)")).toBe(true)
  })

  test("Restore stays on the existing toast with the existing actions", () => {
    const source = read("./layout/folder-missing.ts")
    expect(source.includes("onClick: () => void open(directory, onOpen)")).toBe(true)
    expect(source.includes("[restore, recreate, choose] : [restore, choose]")).toBe(true)
  })
})
