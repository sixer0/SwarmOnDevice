import { createEffect, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { playSoundById } from "@/utils/sound"
import { sessionHref } from "@/utils/session-route"
import { dismissToast, showToast } from "@/utils/toast"

/**
 * Tells the person when autonomous mode has nothing left it can do without them. Every layout has to call this: the
 * server sends `autonomy.blocked` once per state, so an event nobody listens to is never repeated.
 *
 * Nothing from the repository reaches the alert: the event carries only a session id, a level and a count. It shows on
 * the open session too, because held decisions have no dock there to say the work stopped. There is no cooldown, so B1
 * still arrives straight after B0 for the same entries.
 */
export function useAutonomyBlockedAlerts() {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const toastBySession = new Map<string, number>()

  const isOpen = (sessionID: string) => location.pathname.endsWith(`/session/${sessionID}`)
  const dismiss = (sessionID: string) => {
    const toastId = toastBySession.get(sessionID)
    if (toastId === undefined) return
    dismissToast(toastId)
    toastBySession.delete(sessionID)
  }

  onMount(() => {
    const unsub = serverSDK().event.listen((e) => {
      if (e.details?.type === "permission.replied") return dismiss(e.details.properties.sessionID)
      if (e.details?.type !== "autonomy.blocked") return

      const sessionID = e.details.properties.sessionID
      const href = sessionHref(server.key, sessionID)
      const title = language.t("notification.permission.title")
      const description = language.t("notification.autonomy.blocked", {
        sessionTitle: serverSync().session.data.info[sessionID]?.title ?? language.t("command.session.new"),
        count: e.details.properties.count,
      })
      if (settings.sounds.permissionsEnabled()) void playSoundById(settings.sounds.permissions())
      if (settings.notifications.permissions()) void platform.notify(title, description, () => navigate(href))

      dismiss(sessionID)
      const open = isOpen(sessionID)
      toastBySession.set(
        sessionID,
        showToast({
          persistent: !open,
          icon: "checklist",
          title,
          description,
          actions: [
            ...(open ? [] : [{ label: language.t("notification.action.goToSession"), onClick: () => navigate(href) }]),
            { label: language.t("common.dismiss"), onClick: "dismiss" as const },
          ],
        }),
      )
    })
    onCleanup(unsub)
  })

  // Arriving at the session is what the alert asked for.
  createEffect(() => {
    if (!location.pathname) return
    ;[...toastBySession.keys()].filter(isOpen).forEach(dismiss)
  })
}
