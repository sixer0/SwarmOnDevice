import { describe, expect, test } from "bun:test"

// Row 24 of docs/2026-11-13_swarm_1_2_8_patch (N8-303, AC-I18N): the 1.2.8 i18n contract. The 90 new app keys of the names
// register (N8-016..N8-022, N8-064..N8-096, N8-117..N8-121, N8-151..N8-175, N8-416..N8-431, N8-451..N8-453, N8-462) carry the
// register text in en and id, the two changed values (N8-118 as corrected R20-C25, N8-482 memory.privacy) carry the corrected
// text, the two R-6 keys are gone, and the 90 keys are held by both exemption lists (en and id only, the 1.2.6/1.2.7 convention).
// Row 24a (C99) adds the two placement retry keys: 92 keys, pin 324.

const app = async (locale: string): Promise<Record<string, string>> => (await import(`./${locale}.ts`)).dict

const NEW_APP: Record<string, { en: string; id: string }> = {
  "memory.refused.indexLong": { en: "A mission index entry is one line of at most {{max}} characters. Shorten the outcome or the triggers.", id: "Entri indeks misi hanya satu baris, paling banyak {{max}} karakter. Persingkat hasil atau pemicunya." },
  "memory.refused.indexBodyLong": { en: "Keep the index entry detail under {{max}} characters; link the final report instead.", id: "Detail entri indeks harus di bawah {{max}} karakter; tautkan laporan akhir sebagai gantinya." },
  "memory.refused.indexFormat": { en: "An index entry reads: date mission-id | outcome | triggers: words | report path.", id: "Entri indeks berbentuk: tanggal id-misi | hasil | triggers: kata | path laporan." },
  "memory.refused.indexFull": { en: "The mission index is full and its older entries cannot be summarised without cutting them. Consolidate older entries first.", id: "Indeks misi penuh dan entri lamanya tidak dapat diringkas tanpa dipotong. Gabungkan entri lama terlebih dahulu." },
  "memory.kind.index": { en: "Mission index", id: "Indeks misi" },
  "memory.index.rollup": { en: "Summary of {{count}} missions, {{period}}", id: "Ringkasan {{count}} misi, {{period}}" },
  "memory.index.hidden": { en: "{{count}} older mission entries are not loaded into new sessions. They are kept and can still be recalled.", id: "{{count}} entri misi lama tidak dimuat ke sesi baru. Entri tetap disimpan dan masih bisa dipanggil." },
  "settings.skills.title": { en: "Skills", id: "Keahlian" },
  "settings.skills.description": { en: "Skills give agents ready instructions for one kind of work. A skill that is off is not offered to agents.", id: "Keahlian memberi agen petunjuk siap pakai untuk satu jenis pekerjaan. Keahlian yang dimatikan tidak ditawarkan ke agen." },
  "settings.skills.empty": { en: "No skills found.", id: "Tidak ada keahlian." },
  "settings.skills.scope.builtin": { en: "Built in", id: "Bawaan" },
  "settings.skills.scope.global": { en: "All projects", id: "Semua proyek" },
  "settings.skills.scope.project": { en: "This project", id: "Proyek ini" },
  "settings.skills.scope.other": { en: "Other folder", id: "Folder lain" },
  "settings.skills.enabled": { en: "Offer to agents", id: "Tawarkan ke agen" },
  "settings.skills.off": { en: "Off", id: "Mati" },
  "settings.skills.triggers": { en: "Suggested when", id: "Disarankan saat" },
  "settings.skills.triggers.keywords": { en: "Words", id: "Kata" },
  "settings.skills.triggers.files": { en: "Files", id: "Berkas" },
  "settings.skills.triggers.missionTypes": { en: "Mission types", id: "Jenis misi" },
  "settings.skills.triggers.none": { en: "Only when asked for by name", id: "Hanya bila diminta dengan nama" },
  "settings.skills.new": { en: "New skill", id: "Keahlian baru" },
  "settings.skills.edit": { en: "Edit", id: "Ubah" },
  "settings.skills.save": { en: "Save skill", id: "Simpan keahlian" },
  "settings.skills.saveFor": { en: "Save for", id: "Simpan untuk" },
  "settings.skills.readOnly": { en: "Built-in skills can be turned off but not edited.", id: "Keahlian bawaan bisa dimatikan tetapi tidak bisa diubah." },
  "settings.skills.drafts.title": { en: "Drafts waiting for your approval", id: "Draf menunggu persetujuan Anda" },
  "settings.skills.drafts.empty": { en: "No drafts.", id: "Tidak ada draf." },
  "settings.skills.drafts.approve": { en: "Approve and save", id: "Setujui dan simpan" },
  "settings.skills.drafts.discard": { en: "Discard", id: "Buang" },
  "settings.skills.saved": { en: "Skill saved. A note about it was added to project memory.", id: "Keahlian disimpan. Satu catatan tentangnya ditambahkan ke memori proyek." },
  "settings.skills.error.nameInvalid": { en: "Use lowercase letters, digits and hyphens, at most {{max}} characters.", id: "Gunakan huruf kecil, angka, dan tanda hubung, paling banyak {{max}} karakter." },
  "settings.skills.error.nameReserved": { en: "That name belongs to a built-in skill. Choose another name.", id: "Nama itu milik keahlian bawaan. Pilih nama lain." },
  "settings.skills.error.frontmatter": { en: "A skill starts with its name and a one-line description between --- lines.", id: "Keahlian diawali nama dan deskripsi satu baris di antara baris ---." },
  "settings.skills.error.triggers": { en: "Triggers: at most {{max}} entries per list, words up to 40 characters, file patterns up to 100.", id: "Pemicu: paling banyak {{max}} isian per daftar, kata sampai 40 karakter, pola berkas sampai 100." },
  "settings.skills.error.tooLarge": { en: "The skill is larger than {{max}} KB. Move long reference text into a separate file.", id: "Keahlian lebih besar dari {{max}} KB. Pindahkan teks rujukan yang panjang ke berkas terpisah." },
  "settings.skills.error.unsafe": { en: "That location is a link or lies outside the skills folder, so nothing was saved.", id: "Lokasi itu berupa tautan atau berada di luar folder keahlian, jadi tidak ada yang disimpan." },
  "settings.skills.error.untrusted": { en: "This project is not trusted, so a skill that runs shell commands cannot be saved here.", id: "Proyek ini belum dipercaya, jadi keahlian yang menjalankan perintah shell tidak bisa disimpan di sini." },
  "settings.skills.error.changed": { en: "The skill changed on disk after you opened it. Reload it and try again.", id: "Keahlian berubah di disk setelah Anda membukanya. Muat ulang lalu coba lagi." },
  "settings.skills.error.draftMissing": { en: "That draft is no longer there.", id: "Draf itu sudah tidak ada." },
  "memory.obsidian.open": { en: "Open graph in Obsidian", id: "Buka grafik di Obsidian" },
  "memory.obsidian.hint": { en: "Opens this project's notes in your Obsidian vault. Obsidian, its plugins and any sync you turned on for this vault can read them.", id: "Membuka catatan proyek ini di vault Obsidian Anda. Obsidian, pluginnya, dan sinkronisasi apa pun yang Anda aktifkan untuk vault ini dapat membacanya." },
  "memory.obsidian.notYet": { en: "No vault notes yet. They appear after the next memory change.", id: "Belum ada catatan di vault. Catatan muncul setelah perubahan memori berikutnya." },
  "memory.obsidian.noApp": { en: "Obsidian is not installed. Install it from Swarm setup, then try again.", id: "Obsidian belum terpasang. Pasang dari penyiapan Swarm, lalu coba lagi." },
  "memory.obsidian.failed": { en: "Could not open Obsidian.", id: "Tidak dapat membuka Obsidian." },
  "session.mission.placement.title": { en: "Where should this mission live?", id: "Di mana misi ini disimpan?" },
  "session.mission.placement.join": { en: "Join {{group}}", id: "Gabung ke {{group}}" },
  "session.mission.placement.new": { en: "New group {{group}}", id: "Grup baru {{group}}" },
  "session.mission.placement.root": { en: "Keep at the Default Project root", id: "Tetap di akar Default Project" },
  "session.mission.placement.note": { en: "Nothing moves until you choose. The mission's memory notes move with it.", id: "Tidak ada yang dipindahkan sebelum Anda memilih. Catatan memori misi ikut dipindahkan." },
  "session.mission.group.product": { en: "Product", id: "Produk" },
  "session.mission.group.institution": { en: "Institution", id: "Lembaga" },
  "session.mission.group.theme": { en: "Research theme", id: "Tema riset" },
  "session.mission.tidy.title": { en: "Tidy existing missions", id: "Rapikan misi yang ada" },
  "session.mission.tidy.description": { en: "Swarm proposes a group for each mission. Check the list, then approve once to move them all.", id: "Swarm mengusulkan grup untuk setiap misi. Periksa daftarnya, lalu setujui sekali untuk memindahkan semuanya." },
  "session.mission.tidy.row": { en: "{{mission}} → {{group}}", id: "{{mission}} → {{group}}" },
  "session.mission.tidy.stay": { en: "stays at the root", id: "tetap di akar" },
  "session.mission.tidy.approve": { en: "Approve and move {{count}} missions", id: "Setujui dan pindahkan {{count}} misi" },
  "session.mission.tidy.decline": { en: "Not now", id: "Jangan sekarang" },
  "session.mission.tidy.progress": { en: "Moving {{done}} of {{total}}…", id: "Memindahkan {{done}} dari {{total}}…" },
  "session.mission.tidy.done": { en: "{{count}} missions moved. Their memory notes moved with them.", id: "{{count}} misi dipindahkan. Catatan memorinya ikut dipindahkan." },
  "session.mission.tidy.stopped": { en: "Stopped at {{mission}}: {{reason}} That move was undone; earlier moves stay.", id: "Berhenti di {{mission}}: {{reason}} Pemindahan itu dibatalkan; pemindahan sebelumnya tetap." },
  "session.mission.move.done": { en: "Moved to {{group}}. Its memory notes moved with it.", id: "Dipindahkan ke {{group}}. Catatan memorinya ikut dipindahkan." },
  "session.mission.move.error.sourceMissing": { en: "The mission folder is no longer there.", id: "Folder misi sudah tidak ada." },
  "session.mission.move.error.targetExists": { en: "A folder with that name already exists in the group.", id: "Folder dengan nama itu sudah ada di grup." },
  "session.mission.move.error.outsideRoot": { en: "Groups must be inside the Default Project.", id: "Grup harus berada di dalam Default Project." },
  "session.mission.move.error.symlink": { en: "The folder is a link. Swarm does not move links.", id: "Folder itu berupa tautan. Swarm tidak memindahkan tautan." },
  "session.mission.move.error.busy": { en: "Another move is running. Try again when it ends.", id: "Pemindahan lain sedang berjalan. Coba lagi setelah selesai." },
  "session.mission.move.error.rolledBack": { en: "The move failed and was undone. Nothing changed.", id: "Pemindahan gagal dan dibatalkan. Tidak ada yang berubah." },
  "session.mission.move.error.failed": { en: "The mission could not be moved: {{reason}}", id: "Misi tidak dapat dipindahkan: {{reason}}" },
  "settings.skills.required": { en: "Required", id: "Wajib" },
  "settings.skills.requiredHint": { en: "Swarm needs this skill to keep project notes in your Obsidian vault, so it cannot be turned off.", id: "Swarm memerlukan keahlian ini untuk menyimpan catatan proyek di vault Obsidian Anda, jadi tidak bisa dimatikan." },
  "settings.skills.view": { en: "View", id: "Lihat" },
  "settings.skills.otherReadOnly": { en: "This skill lives in another tool's folder. Swarm can turn it off but does not edit or delete it.", id: "Keahlian ini berada di folder alat lain. Swarm bisa mematikannya tetapi tidak mengubah atau menghapusnya." },
  "settings.skills.drafts.untrusted": { en: "Written after the agent read web pages, tool output or files outside this project. Read every line before you approve.", id: "Ditulis setelah agen membaca halaman web, keluaran alat, atau berkas di luar proyek ini. Baca setiap baris sebelum menyetujui." },
  "settings.skills.drafts.runsCommands": { en: "This skill runs shell commands when it is loaded.", id: "Keahlian ini menjalankan perintah shell saat dimuat." },
  "settings.skills.drafts.replaces": { en: "Approving replaces the saved skill with the same name.", id: "Menyetujui akan menggantikan keahlian tersimpan dengan nama yang sama." },
  "settings.skills.deleteConfirm": { en: "Move skill {{name}} to the archive? Agents will no longer be offered it. The files stay in the archive until you remove them.", id: "Pindahkan keahlian {{name}} ke arsip? Agen tidak akan ditawari keahlian ini lagi. Berkasnya tetap di arsip sampai Anda menghapusnya." },
  "settings.skills.deleted": { en: "Skill moved to the archive.", id: "Keahlian dipindahkan ke arsip." },
  "settings.skills.savedNoNote": { en: "Skill saved. No note was added to project memory because memory is off or refused it.", id: "Keahlian disimpan. Tidak ada catatan yang ditambahkan ke memori proyek karena memori mati atau menolaknya." },
  "settings.skills.error.notFound": { en: "That skill is no longer there.", id: "Keahlian itu sudah tidak ada." },
  "settings.skills.error.archive": { en: "The skill could not be moved to the archive, so nothing was deleted.", id: "Keahlian tidak bisa dipindahkan ke arsip, jadi tidak ada yang dihapus." },
  "settings.skills.error.personOnly": { en: "Skills can be saved only from the Swarm desktop app.", id: "Keahlian hanya bisa disimpan dari aplikasi desktop Swarm." },
  "settings.skills.drafts.confirmCommands": { en: "This skill runs shell commands every time it is loaded. Approve anyway?", id: "Keahlian ini menjalankan perintah shell setiap kali dimuat. Tetap setujui?" },
  "settings.skills.drafts.confirmCommandsGlobal": { en: "This skill runs shell commands every time it is loaded in every project. Approve anyway?", id: "Keahlian ini menjalankan perintah shell setiap kali dimuat di setiap proyek. Tetap setujui?" },
  "settings.skills.error.shellUnconfirmed": { en: "Approving a skill that runs shell commands needs your explicit confirmation.", id: "Menyetujui keahlian yang menjalankan perintah shell memerlukan konfirmasi eksplisit Anda." },
  "session.mission.move.error.sessionActive": { en: "A session of this mission is still working. Try again when it is idle.", id: "Sesi misi ini masih bekerja. Coba lagi setelah selesai." },
  "session.mission.move.error.rollbackFailed": { en: "The move failed and could not be fully undone. A backup was kept; see {{path}}.", id: "Pemindahan gagal dan tidak dapat dibatalkan sepenuhnya. Cadangan disimpan; lihat {{path}}." },
  "session.mission.placement.waitIdle": { en: "Available when the mission's session is idle.", id: "Tersedia setelah sesi misi selesai bekerja." },
  "session.mission.decision.unattested": { en: "Recorded by an agent on your behalf", id: "Dicatat oleh agen atas nama Anda" },
  // row 24a (C99, N8-C19): the placement retry card (C98).
  "session.mission.placement.unplaced": { en: "Your answer is saved, but the mission has not moved yet.", id: "Jawaban Anda tersimpan, tetapi misi belum dipindahkan." },
  "session.mission.placement.retry": { en: "Try the move to {{group}} again", id: "Coba lagi pindahkan ke {{group}}" },
}

const PRIVACY_SENTENCE = {
  en: "When a mission moves into a group, Swarm keeps a backup copy of this project's memory file in its data folder.",
  id: "Saat misi dipindahkan ke grup, Swarm menyimpan salinan cadangan berkas memori proyek ini di folder datanya.",
}

describe("1.2.8 i18n contract (N8-303)", () => {
  test("the register lists 92 new app keys", () => {
    expect(Object.keys(NEW_APP).length).toBe(92)
  })

  test("every new key carries the register text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await app(locale)
      for (const [key, text] of Object.entries(NEW_APP))
        expect({ locale, key, value: dict[key] }).toEqual({ locale, key, value: text[locale] })
    }
  })

  test("N8-118 carries the corrected tooltip (SR8-20) and no graph-command claim", async () => {
    const en = (await app("en"))["memory.obsidian.hint"]
    const id = (await app("id"))["memory.obsidian.hint"]
    expect(en).toContain("Obsidian, its plugins and any sync you turned on for this vault can read them.")
    expect(id).toContain("sinkronisasi apa pun yang Anda aktifkan untuk vault ini dapat membacanya.")
    expect(en.toLowerCase()).not.toContain("graph")
  })

  test("N8-482 memory.privacy keeps its 1.2.7 text and appends the backup sentence (SR8-19)", async () => {
    const en = (await app("en"))["memory.privacy"]
    const id = (await app("id"))["memory.privacy"]
    expect(en.startsWith("Kept on this device, never in the repository.")).toBe(true)
    expect(en.endsWith(PRIVACY_SENTENCE.en)).toBe(true)
    expect(id.startsWith("Disimpan di perangkat ini, tidak pernah di repositori.")).toBe(true)
    expect(id.endsWith(PRIVACY_SENTENCE.id)).toBe(true)
  })

  test("the two R-6 keys are absent from en and id", async () => {
    for (const locale of ["en", "id"]) {
      const dict = await app(locale)
      expect(Object.hasOwn(dict, "session.mission.decision.answered")).toBe(false)
      expect(Object.hasOwn(dict, "session.mission.decision.recorded")).toBe(false)
    }
  })

  test("the 92 new keys are exempt in both lists, memory.privacy is not, and no other locale carries them", async () => {
    const parity = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    for (const key of Object.keys(NEW_APP)) {
      expect({ key, parity: parity.includes(`"${key}",`) }).toEqual({ key, parity: true })
      expect({ key, guard: guard.includes(`"${key}",`) }).toEqual({ key, guard: true })
    }
    expect(parity.includes('"memory.privacy",')).toBe(false)
    expect(guard.includes('"memory.privacy",')).toBe(false)
    const fr = await app("fr")
    for (const key of Object.keys(NEW_APP)) expect({ key, present: Object.hasOwn(fr, key) }).toEqual({ key, present: false })
  })

  test("the exemption pin is 324 at both sites", async () => {
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(guard.split("toBe(324)").length - 1).toBe(2)
  })
})
