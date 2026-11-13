import { describe, expect, test } from "bun:test"

// Row 22 of docs/2026-11-13_swarm_1_2_7_patch (N7-081): the 1.2.7 i18n contract. Every key of
// N7-020..N7-053 and N7-127 is present in en and id with the register text, and is held by both
// exemption lists (en and id only, the 1.2.6 convention). The two ui keys live in the ui catalogue.

const app = async (locale: string): Promise<Record<string, string>> => (await import(`./${locale}.ts`)).dict
const ui = async (locale: string): Promise<Record<string, string>> =>
  (await import(`../../../ui/src/i18n/${locale}.ts`)).dict

const APP: Record<string, { en: string; id: string }> = {
  "session.mission.deliverable.notInProject": {
    en: "Not in this project yet. The agent saves it to docs/{{mission}}/11_deliverables.",
    id: "Belum ada di proyek ini. Agen menyimpannya ke docs/{{mission}}/11_deliverables.",
  },
  "session.mission.emptySession": {
    en: "No missions in this session. A mission started in another session shows in that session's window.",
    id: "Belum ada misi di sesi ini. Misi yang dimulai di sesi lain tampil di jendela sesi tersebut.",
  },
  "session.mission.deliverable.revealOnly": {
    en: "Swarm never runs scripts or apps from here.",
    id: "Swarm tidak pernah menjalankan skrip atau aplikasi dari sini.",
  },
  "session.map.filter.shared": { en: "Shared files", id: "Berkas bersama" },
  "toast.project.folderMissing.title": { en: "Project folder not found", id: "Folder proyek tidak ditemukan" },
  "toast.project.folderMissing.description": {
    en: "{{path}} no longer exists. Put it back and press Restore, recreate it as an empty folder, or choose another folder.",
    id: "{{path}} sudah tidak ada. Kembalikan foldernya lalu tekan Pulihkan, buat ulang sebagai folder kosong, atau pilih folder lain.",
  },
  "toast.project.folderMissing.restore": { en: "Restore", id: "Pulihkan" },
  "toast.project.folderMissing.recreate": { en: "Recreate", id: "Buat ulang" },
  "toast.project.folderMissing.choose": { en: "Choose folder", id: "Pilih folder" },
  "toast.project.folderMissing.recreateFailed": {
    en: "{{path}} could not be recreated because its parent folder is missing too. Choose another folder.",
    id: "{{path}} tidak bisa dibuat ulang karena folder induknya juga tidak ada. Pilih folder lain.",
  },
  "session.map.decisions.category.own_api": { en: "Calls Swarm's own server", id: "Memanggil server Swarm sendiri" },
}
const UI: Record<string, { en: string; id: string }> = {
  "ui.messagePart.reasoning.show": { en: "Show thinking", id: "Tampilkan proses berpikir" },
  "ui.messagePart.reasoning.hide": { en: "Hide thinking", id: "Sembunyikan proses berpikir" },
}
const NEW_KEYS = [...Object.keys(APP).filter((k) => k !== "session.mission.deliverable.notInProject"), ...Object.keys(UI)]

describe("1.2.7 i18n contract (N7-081)", () => {
  test("app keys carry the register text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await app(locale)
      for (const [key, text] of Object.entries(APP)) expect({ locale, key, value: dict[key] }).toEqual({ locale, key, value: text[locale] })
    }
  })

  test("ui keys carry the register text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await ui(locale)
      for (const [key, text] of Object.entries(UI)) expect({ locale, key, value: dict[key] }).toEqual({ locale, key, value: text[locale] })
    }
  })

  test("N7-020 changed text points to 11_deliverables and no other locale carries the key", async () => {
    expect((await app("en"))["session.mission.deliverable.notInProject"]).toContain("docs/{{mission}}/11_deliverables.")
    expect((await app("fr"))["session.mission.deliverable.notInProject"]).toBeUndefined()
  })

  test("the 12 new keys are exempt in both lists (en and id only)", async () => {
    const parity = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(NEW_KEYS.length).toBe(12)
    for (const key of NEW_KEYS) {
      expect({ key, parity: parity.includes(`"${key}",`) }).toEqual({ key, parity: true })
      expect({ key, guard: guard.includes(`"${key}",`) }).toEqual({ key, guard: true })
    }
    expect((await app("fr"))["session.mission.emptySession"]).toBeUndefined()
  })
})
