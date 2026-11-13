import { describe, expect, test } from "bun:test"
import { directoryPickerArgs } from "./picker-options"

describe("directoryPickerArgs", () => {
  test("forwards defaultPath to the desktop directory picker", () => {
    expect(directoryPickerArgs({ title: "Choose", defaultPath: "/home/u" })).toEqual({
      multiple: false,
      title: "Choose",
      defaultPath: "/home/u",
    })
  })

  test("without options keeps the previous single-select call", () => {
    expect(directoryPickerArgs()).toEqual({ multiple: false, title: undefined, defaultPath: undefined })
  })
})
