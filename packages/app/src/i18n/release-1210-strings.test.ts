import { describe, expect, test } from "bun:test"

// Row 41 of docs/2026-11-15_swarm_1_2_10_patch (N10-155, AC-B1017w): the 1.2.10 app i18n contract.
// N10-080..N10-097 and N10-102 are 19 new keys (N10-083/084 are the two plural forms of the drift line), N10-098 changes the
// value of `toast.project.folderMissing.recreateFailed` (key unchanged, AC-B1017w). The new keys are exempt in both lists
// (en and id only, the 1.2.6-1.2.9 convention): 330 + 19 = 349 (N10-100: +3 N10-080..082, +2 N10-083/084, +13 N10-085..097,
// +1 N10-102; N10-098 changes a value, not a key).

const app = async (locale: string): Promise<Record<string, string>> => (await import(`./${locale}.ts`)).dict

// 1.3.1 row H1 (B13-49): the three Obsidian outcome texts name the configured vault through {{vault}}.
const NEW_APP: Record<string, { en: string; id: string }> = {
  "memory.obsidian.registered": {
    en: "Swarm added the Swarm vault ({{vault}}) to Obsidian's vault list.",
    id: "Swarm menambahkan vault Swarm ({{vault}}) ke daftar vault Obsidian.",
  },
  "memory.obsidian.closeObsidian": {
    en: "Close Obsidian, then press Open graph in Obsidian again. If Obsidian is already closed, open it once and quit it normally. Or add the folder yourself: in Obsidian choose Open folder as vault and pick {{vault}}.",
    id: "Tutup Obsidian, lalu tekan Buka grafik di Obsidian lagi. Jika Obsidian sudah tertutup, buka sekali lalu keluar seperti biasa. Atau tambahkan foldernya sendiri: di Obsidian pilih Open folder as vault lalu pilih {{vault}}.",
  },
  "memory.obsidian.notRegistered": {
    en: "Swarm could not add the Swarm vault to Obsidian's vault list safely, so it changed nothing. Add it yourself: in Obsidian choose Open folder as vault and pick {{vault}}.",
    id: "Swarm tidak dapat menambahkan vault Swarm ke daftar vault Obsidian dengan aman, jadi tidak ada yang diubah. Tambahkan sendiri: di Obsidian pilih Open folder as vault lalu pilih {{vault}}.",
  },
  "session.mission.line.driftChanged.one": {
    en: "{{count}} step changed after approval.",
    id: "{{count}} langkah diubah setelah persetujuan.",
  },
  "session.mission.line.driftChanged.other": {
    en: "{{count}} steps changed after approval.",
    id: "{{count}} langkah diubah setelah persetujuan.",
  },
  "memory.vault.copy": { en: "Copy to vault", id: "Salin ke vault" },
  "memory.vault.remove": { en: "In vault: remove", id: "Di vault: hapus" },
  "memory.vault.confirmText": {
    en: "Copy this note to the Obsidian vault? Obsidian, its plugins, any sync you turn on, and agents allowed to read outside the project (for example in autonomous mode) can read the copy. Swarm still gives the note only to on-device models. You can remove it from the vault later.",
    id: "Salin catatan ini ke vault Obsidian? Obsidian, pluginnya, sinkronisasi apa pun yang Anda aktifkan, dan agen yang boleh membaca di luar proyek (misalnya dalam mode otonom) dapat membaca salinannya. Swarm tetap hanya memberikan catatan ini ke model di perangkat ini. Anda dapat menghapusnya dari vault nanti.",
  },
  "memory.vault.confirmTextIndex": {
    en: "Its final report {{report}} is copied with it, under the existing report rules.",
    id: "Laporan akhirnya {{report}} ikut disalin, dengan aturan laporan yang sudah ada.",
  },
  "memory.vault.confirmCopy": { en: "Copy", id: "Salin" },
  "memory.vault.confirmCancel": { en: "Cancel", id: "Batal" },
  "memory.vault.rule": {
    en: "Notes kept on this device, secret-looking notes and notes marked as classified are not copied to the Obsidian vault. Notes for any model are copied. You can copy a note kept on this device yourself.",
    id: "Catatan yang hanya di perangkat ini, catatan yang tampak berisi rahasia, dan catatan yang ditandai sebagai dokumen berklasifikasi tidak disalin ke vault Obsidian. Catatan untuk model apa pun disalin. Anda dapat menyalin sendiri catatan yang hanya di perangkat ini.",
  },
  "memory.vault.reason.device": { en: "Kept on this device", id: "Hanya di perangkat ini" },
  "memory.vault.reason.secret": {
    en: "Looks secret: never copied",
    id: "Tampak berisi rahasia: tidak pernah disalin",
  },
  "memory.vault.reason.classified": {
    en: "Marked as classified: never copied",
    id: "Ditandai berklasifikasi: tidak pernah disalin",
  },
  "memory.vault.personOnly": { en: "Only in the Swarm desktop app.", id: "Hanya di aplikasi desktop Swarm." },
  "memory.refused.classified": {
    en: "This note is marked as classified, so it is never copied to the vault.",
    id: "Catatan ini ditandai sebagai dokumen berklasifikasi, jadi tidak pernah disalin ke vault.",
  },
  "memory.refused.notDeviceOnly": {
    en: "This note is already copied to the vault because any model may receive it.",
    id: "Catatan ini sudah disalin ke vault karena model apa pun boleh menerimanya.",
  },
  "memory.refused.archived": {
    en: "This entry is part of a summary. Copy the summary instead.",
    id: "Entri ini bagian dari ringkasan. Salin ringkasannya saja.",
  },
}

// N10-098 / AC-B1017w: the value changes, the key stays. It says only that the parent folder is missing too (or something else is there).
const RECREATE_FAILED = "toast.project.folderMissing.recreateFailed"
const RECREATE_FAILED_TEXT = {
  en: "{{path}} could not be recreated: its parent folder is missing or something else is at that path. Choose another folder.",
  id: "{{path}} tidak bisa dibuat ulang: folder induknya tidak ada atau ada sesuatu yang lain di jalur itu. Pilih folder lain.",
}

describe("1.2.10 i18n contract (N10-155)", () => {
  test("the register lists 19 new app keys", () => {
    expect(Object.keys(NEW_APP).length).toBe(19)
  })

  test("every new key carries the register text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await app(locale)
      for (const [key, text] of Object.entries(NEW_APP))
        expect({ locale, key, value: dict[key] }).toEqual({ locale, key, value: text[locale] })
    }
  })

  test("N10-098 recreateFailed keeps its key and carries the new text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await app(locale)
      expect({ locale, value: dict[RECREATE_FAILED] }).toEqual({ locale, value: RECREATE_FAILED_TEXT[locale] })
    }
  })

  test("the memory.vault family has no dotted key under a leaf key (confirmText and confirmTextIndex are siblings)", async () => {
    const en = await app("en")
    expect(Object.hasOwn(en, "memory.vault.confirm")).toBe(false)
    expect(Object.hasOwn(en, "memory.vault.confirmText")).toBe(true)
    expect(Object.hasOwn(en, "memory.vault.confirmTextIndex")).toBe(true)
  })

  test("the drift line is plural-only: the bare key is gone and the id catalogue keeps one text for both forms", async () => {
    for (const locale of ["en", "id"]) {
      const dict = await app(locale)
      expect({ locale, present: Object.hasOwn(dict, "session.mission.line.driftChanged") }).toEqual({ locale, present: false })
    }
    const id = await app("id")
    expect(id["session.mission.line.driftChanged.one"]).toBe(id["session.mission.line.driftChanged.other"])
    const lang = await Bun.file(new URL("../context/language.tsx", import.meta.url)).text()
    expect(lang.includes('| "session.mission.line.driftChanged"')).toBe(true)
  })

  test("the 19 new keys are exempt in both lists and no other locale carries them", async () => {
    const parity = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    for (const key of Object.keys(NEW_APP)) {
      expect({ key, parity: parity.includes(`"${key}",`) }).toEqual({ key, parity: true })
      expect({ key, guard: guard.includes(`"${key}",`) }).toEqual({ key, guard: true })
    }
    const fr = await app("fr")
    for (const key of Object.keys(NEW_APP)) expect({ key, present: Object.hasOwn(fr, key) }).toEqual({ key, present: false })
  })

  test("the exemption pin is 349 at both sites (330 + 19)", async () => {
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(guard.split("toBe(349)").length - 1).toBe(2)
    expect(guard.split("toBe(330)").length - 1).toBe(0)
  })
})
