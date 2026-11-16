// Light or dark from the Office theme (FS FR-62, design §8, H-UI-1). Office decides light versus
// dark only; every colour comes from the Swarm v2 tokens scoped by `data-color-scheme`.
export type ColorScheme = "light" | "dark"

export type OfficeThemeLike = { isDarkTheme?: boolean; bodyBackgroundColor?: string } | undefined

// WCAG relative luminance of a #rgb / #rrggbb colour, or undefined when it cannot be parsed.
export function luminance(color: string) {
  const hex = color.trim().replace(/^#/, "")
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex.slice(0, 6)
  if (!/^[0-9a-f]{6}$/i.test(full)) return undefined
  const channel = (offset: number) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

// 1. `isDarkTheme` when defined; 2. else the luminance of `bodyBackgroundColor` (below 0.5 is
// dark); 3. `officeTheme` undefined (or unusable): `prefers-color-scheme`.
export function resolveScheme(theme: OfficeThemeLike, prefersDark: boolean): ColorScheme {
  if (theme && typeof theme.isDarkTheme === "boolean") return theme.isDarkTheme ? "dark" : "light"
  const value = theme?.bodyBackgroundColor ? luminance(theme.bodyBackgroundColor) : undefined
  if (value !== undefined) return value < 0.5 ? "dark" : "light"
  return prefersDark ? "dark" : "light"
}

export type ThemeSource = {
  officeTheme: () => OfficeThemeLike
  // `matchMedia("(prefers-color-scheme: dark)")`, when the web view has it.
  media?: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">
  // Subscribes to Office's OfficeThemeChanged event when the host supports it.
  subscribeOffice?: (listener: () => void) => void
  root: HTMLElement
}

// Applies the scheme now and on both change events; returns the unsubscribe for the media query.
export function watchScheme(source: ThemeSource) {
  const apply = () => {
    source.root.dataset.colorScheme = resolveScheme(source.officeTheme(), source.media?.matches === true)
  }
  apply()
  source.subscribeOffice?.(apply)
  source.media?.addEventListener("change", apply)
  return () => source.media?.removeEventListener("change", apply)
}
