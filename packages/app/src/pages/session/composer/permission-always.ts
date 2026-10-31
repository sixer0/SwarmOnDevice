const MAX_SCOPE = 40

/**
 * What the "always" button says. A rule for one command names it, so a person can see how far the answer reaches: "Always
 * allow git status" and not a bare "Allow always". A rule for everything a tool does, or several, keeps the plain words.
 */
export function alwaysLabel(always: readonly string[], t: (key: "ui.permission.allowAlways" | "session.permission.alwaysNamed", params?: { scope: string }) => string) {
  const scope = always.length === 1 && always[0] !== "*" ? always[0]!.replace(/ \*$/, "") : undefined
  return scope && scope.length <= MAX_SCOPE ? t("session.permission.alwaysNamed", { scope }) : t("ui.permission.allowAlways")
}
