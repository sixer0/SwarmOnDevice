// Keyboard behaviour of the Home pane. The pane's search box is never taken out of the document by a refetch (its
// query reads settle once, see settled-query-data.ts), so focus only has to be put there once.

const isIdle = (root: HTMLElement) => {
  const active = document.activeElement
  return !active || active === document.body || active === root
}

/**
 * Esc that reaches the window while the pane is open. Closes the pane when focus is inside the pane or on nothing
 * (<body>), unless someone already handled the key (a dialog, a popover, the search box) or a dialog is open; focus in
 * the chat composer or any other field outside the pane keeps its own Esc.
 */
export function shouldCloseOnWindowEscape(event: KeyboardEvent, root: HTMLElement | undefined) {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return false
  const active = document.activeElement
  if (active && active !== document.body && !root?.contains(active)) return false
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
  return !Array.from(dialogs).some((dialog) => !root?.contains(dialog))
}

/**
 * Puts the keyboard in the pane's search box, from wherever it was (the chat composer included). Until the box exists
 * (its project and first session list still loading) the pane itself holds focus, so Esc already closes it; the box
 * takes over when it appears, unless focus has gone somewhere else meanwhile. Returns a function that stops waiting.
 */
export function focusPaneSearch(root: HTMLElement) {
  const search = () => root.querySelector<HTMLInputElement>('[data-component="home-session-search"] input')
  const box = search()
  if (box) {
    box.focus()
    return () => {}
  }
  root.focus()
  const observer = new MutationObserver(() => {
    const box = search()
    if (!box) return
    stop()
    if (isIdle(root)) box.focus()
  })
  // Any focus that lands elsewhere (a click on the composer, a row, the close button) ends the wait.
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== root) stop()
  }
  const stop = () => {
    observer.disconnect()
    document.removeEventListener("focusin", onFocusIn, true)
  }
  observer.observe(root, { childList: true, subtree: true })
  document.addEventListener("focusin", onFocusIn, true)
  return stop
}
