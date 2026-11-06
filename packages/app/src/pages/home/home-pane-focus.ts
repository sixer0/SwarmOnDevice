// Keyboard behaviour of the Home pane that has to survive Suspense. A query read inside the pane can suspend its
// boundary after mount (and again on a refetch); Solid then takes the pane's DOM out of the document and puts the same
// nodes back once the read settles. A focused element that leaves the document drops focus to <body>, so without this
// the search box loses focus right after mod+b and Esc has no pane target.

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
 * Puts focus in the pane's search box and keeps it there across Suspense detaches. `request()` focuses the search box
 * (the pane itself until the box exists, then the box). An element of the pane that loses focus because it left the
 * document gets it back when it returns, as long as focus did not go anywhere else meanwhile.
 */
export function createPaneFocusKeeper(root: HTMLElement) {
  let pending: (() => HTMLElement | null) | undefined
  let observer: MutationObserver | undefined
  let disposed = false

  const stop = () => {
    pending = undefined
    observer?.disconnect()
    observer = undefined
  }

  const apply = () => {
    if (!pending || disposed) return stop()
    const target = pending()
    if (target?.isConnected && isIdle(root) && document.activeElement !== target) target.focus()
    // Done once a real control (not the pane fallback) holds focus; otherwise wait for the next DOM change.
    if (target && target !== root && document.activeElement === target) return stop()
    if (!observer) {
      observer = new MutationObserver(apply)
      observer.observe(document.body, { childList: true, subtree: true })
    }
  }

  const search = () => root.querySelector<HTMLInputElement>("input") ?? root

  // The pane element that holds focus. Tracked on the document: a node Suspense took out of the pane may report its
  // focusout after it left, so the event would no longer pass through the pane root.
  let inside: HTMLElement | undefined

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (target === root) return
    inside = target instanceof HTMLElement && root.contains(target) ? target : undefined
    // Focus landed somewhere real (the composer, a pane row, the box itself): nothing left to restore.
    stop()
  }

  const onFocusOut = (event: FocusEvent) => {
    const element = inside
    if (event.relatedTarget || !element || event.target !== element) return
    // The search box blurring itself on Esc, or a click on the chat background, leaves it in the document: not ours.
    lost(element)
    queueMicrotask(() => {
      lost(element)
      // Still in the document: a deliberate blur, so a later detach of this node must not pull focus back.
      if (element.isConnected && inside === element) inside = undefined
    })
  }

  const lost = (element: HTMLElement) => {
    if (disposed || element.isConnected || pending) return
    inside = undefined
    pending = () => element
    apply()
  }

  // Covers an engine that drops focus from a removed node without any focusout: a removal inside the pane is seen here.
  const watch = new MutationObserver(() => {
    if (inside) lost(inside)
  })
  watch.observe(root, { childList: true, subtree: true })

  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("focusout", onFocusOut, true)

  return {
    request() {
      pending = search
      apply()
    },
    dispose() {
      disposed = true
      stop()
      watch.disconnect()
      document.removeEventListener("focusin", onFocusIn, true)
      document.removeEventListener("focusout", onFocusOut, true)
    },
  }
}
