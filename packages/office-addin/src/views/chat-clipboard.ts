// Copy per reply (FS FR-57, design §4.2, plan M8-06). The clipboard only, never the document.
// `navigator.clipboard.writeText` first; when it is missing or rejects (WKWebView without a
// user-activation grant, H-UI-3), a hidden read-only textarea and `execCommand("copy")` inside
// the same click. Both are injected so the fallback is testable without a real clipboard.

export type ClipboardEnv = {
  clipboard?: { writeText: (text: string) => Promise<void> }
  document: Pick<Document, "createElement" | "body" | "execCommand">
}

export async function copyText(env: ClipboardEnv, text: string) {
  const viaApi = env.clipboard
    ? await env.clipboard.writeText(text).then(
        () => true,
        () => false,
      )
    : false
  if (viaApi) return true
  const field = env.document.createElement("textarea")
  field.value = text
  field.setAttribute("readonly", "")
  field.style.position = "fixed"
  field.style.opacity = "0"
  env.document.body.append(field)
  field.select()
  const ok = env.document.execCommand("copy")
  field.remove()
  return ok
}
