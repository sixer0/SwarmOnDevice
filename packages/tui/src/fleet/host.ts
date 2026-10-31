import { createSignal } from "solid-js"

// The few facts the fleet plugin and the App shell share. The plugin API has no server URL, and App owns the terminal title.
const [waiting, setWaiting] = createSignal(0)
const [server, setServer] = createSignal<string>()

export const fleetHost = {
  /** How many agents anywhere need the user, for the terminal title tmux and SSH users see. */
  waiting,
  setWaiting,
  /** The attach URL, or undefined for this process's private in-process server. */
  server,
  setServer(url: string) {
    setServer(new URL(url).hostname.endsWith(".internal") ? undefined : url)
  },
}
