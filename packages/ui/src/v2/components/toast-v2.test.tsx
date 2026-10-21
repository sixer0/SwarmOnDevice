import { describe, expect, test } from "bun:test"

// Contract checks for the toast region's accessible name (jury finding F-D2-2).
//
// These are static checks over two files on disk, not a rendered assertion. A rendered check is not
// available in this package: `packages/ui` declares no DOM environment (its test script is
// `bun test src --only-failures`, with no bunfig.toml preload), and happy-dom resolves only for
// `packages/app` (`packages/app/package.json:35` declares @happy-dom/global-registrator;
// `bun -e "await import('@happy-dom/global-registrator')"` from packages/ui exits with
// "Cannot find module"). Importing the component itself also needs `--conditions=solid`, which the
// package's own test script does not pass. Rendering evidence therefore belongs to the app's
// happy-dom lane or to the browser re-capture wave; see implementation/s5_r170_toast_aria.md §4.

const componentPath = `${import.meta.dir}/toast-v2.tsx`

async function componentSource() {
  return await Bun.file(componentPath).text()
}

describe("ToastV2.Region accessible name", () => {
  test("names the region through the i18n layer instead of relying on the vendor default", async () => {
    const source = await componentSource()

    // The key is one shared name, not a copy-pasted string: read it back out of the module.
    const keyMatch = source.match(/export const TOAST_V2_REGION_ARIA_KEY = "([^"]+)"/)
    expect(keyMatch).not.toBeNull()
    const regionKey = keyMatch?.[1] ?? ""
    expect(regionKey).toMatch(/^ui\.[A-Za-z0-9.]+$/)

    // The prop must be an i18n call for that key, never an English literal.
    expect(source).toMatch(/customAriaLabel=\{i18n\.t\(TOAST_V2_REGION_ARIA_KEY\)}/)
    expect(source).not.toMatch(/customAriaLabel="/)
    // An English fallback would reintroduce the defect behind the i18n call.
    expect(source).not.toMatch(/TOAST_V2_REGION_ARIA_KEY\s*\?\?/)
    expect(source).not.toMatch(/customAriaLabel=\{[^}]*\?\?\s*"/)
  })

  test("the sibling close-button label stays localised through the same layer", async () => {
    const source = await componentSource()
    expect(source).toMatch(/closeButtonAriaLabel:[^}]*i18n\.t\("ui\.common\.dismiss"\)/)
  })

  test("carries no shortcut hint in the accessible name", async () => {
    const source = await componentSource()
    // Alt+T is solid-sonner's own hotkey, not a shortcut this product registers or lists, so the
    // region name must not reproduce it or hand the vendor another label to compose it onto.
    expect(source).not.toMatch(/alt\+T/i)
    expect(source).not.toMatch(/containerAriaLabel=/)
    expect(source).not.toMatch(/hotkey=\{/)
  })

  test("solid-sonner honours customAriaLabel over its English default and hotkey suffix", async () => {
    const distPath = import.meta.resolve("solid-sonner")
    const dist = await Bun.file(new URL(distPath)).text()

    // The shipped composition: a non-empty customAriaLabel wins outright, so neither the
    // "Notifications" default nor the " alt+T" suffix reaches the DOM once we pass the prop.
    expect(dist).toContain('containerAriaLabel: "Notifications"')
    expect(dist).toMatch(/setAttribute\([\w$]+, "aria-label", propsWithDefaults\.customAriaLabel \?\? `\$\{[^}]*containerAriaLabel\} \$\{hotkeyLabel\(\)\}`\)/)
    expect(dist).toMatch(/const hotkeyLabel = \(\) => propsWithDefaults\.hotkey\.join\("\+"\)/)
  })
})
