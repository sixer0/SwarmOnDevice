// DATUM render bridge: IBM Plex @font-face block from the bundled fonts folder (runtime spec §4).
//
// Built once at bridge start as data: URLs, so the render page never needs file:// for fonts.
// Mapping follows embed_fonts.py:124-133: SemiBold also answers weight 700 (Bold = SemiBold).

import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { BridgeError } from "./protocol"

const FAMILIES: Record<string, string[]> = {
  Sans: ["IBM Plex Sans"],
  SansCond: ["IBM Plex Sans Condensed", "IBM Plex Sans Cond"],
  Serif: ["IBM Plex Serif"],
  Mono: ["IBM Plex Mono"],
}

const FACES: Record<string, { weight: string; style: "normal" | "italic" }> = {
  Regular: { weight: "400", style: "normal" },
  Italic: { weight: "400", style: "italic" },
  SemiBold: { weight: "600 700", style: "normal" },
  SemiBoldItalic: { weight: "600 700", style: "italic" },
}

export const FONT_FILES = Object.keys(FAMILIES).flatMap((fam) => Object.keys(FACES).map((face) => `IBMPlex${fam}-${face}.ttf`))

export type FontBundle = {
  css: string
  /** Real paths of the 16 files (for the renderer file allow-list). */
  files: string[]
  faceCount: number
}

export function buildFontBundle(dir: string): FontBundle {
  const rules: string[] = []
  const files: string[] = []
  const missing: string[] = []
  for (const fam of Object.keys(FAMILIES)) {
    for (const face of Object.keys(FACES)) {
      const name = `IBMPlex${fam}-${face}.ttf`
      let bytes: Buffer
      let path: string
      try {
        path = realpathSync(join(dir, name))
        bytes = readFileSync(path)
      } catch {
        missing.push(name)
        continue
      }
      files.push(path)
      const url = `data:font/ttf;base64,${bytes.toString("base64")}`
      const { weight, style } = FACES[face]
      for (const family of FAMILIES[fam]) {
        rules.push(
          `@font-face{font-family:"${family}";src:url(${url}) format("truetype");font-weight:${weight};font-style:${style};font-display:block}`,
        )
      }
    }
  }
  if (missing.length) throw new BridgeError("FONTS_MISSING", `bundled fonts missing: ${missing.join(", ")}`)
  return { css: rules.join("\n"), files, faceCount: rules.length }
}
