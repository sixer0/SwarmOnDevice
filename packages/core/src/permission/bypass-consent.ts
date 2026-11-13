// 1.2.7 U-10 (decision C63): the bypass-v1 consent text, the one source for every place that asks for it. The app's
// consent screen (app/src/i18n en.ts and id.ts, keys dialog.autonomyBypass.*) and `swarm autonomy on` both read it, so
// what a person agrees to in the app and at a terminal cannot drift. A change to the wording is a new consent version:
// change `BYPASS_CONSENT_VERSION` with it, here and in the server's `Autonomy.BYPASS_CONSENT`.

export const BYPASS_CONSENT_VERSION = "bypass-v1"

export type BypassConsentPart =
  | "title"
  | "intro"
  | "archive"
  | "refused"
  | "waits"
  | "secrets"
  | "report"
  | "scope"
  | "accept"

/** The paragraphs a person reads before agreeing, in the order the consent screen shows them. */
export const BYPASS_CONSENT_PARAGRAPHS = ["intro", "archive", "refused", "waits", "secrets", "report", "scope"] as const

export const BYPASS_CONSENT_TEXT: Record<"en" | "id", Record<BypassConsentPart, string>> = {
  en: {
    title: "Turn on autonomous mode?",
    intro:
      "While this mode is on, nothing waits for you. Approvals are bypassed and the main agent decides, for you and for its subagents. Every action either runs, or the agent gets an immediate answer that tells it what to do instead, so the work never stops to ask you. Tests, builds and installs run the project's code and its packages' code as written, and Swarm does not check what that code does. Every decision is recorded in Activity, including the actions that did not run.",
    archive:
      "Files and folders that Swarm deletes are moved to the archive. Local actions that cannot be undone, such as git reset --hard, git clean or deleting a branch, run after Swarm saves a checkpoint of the files and Git refs they change, and you can revert that checkpoint later. A deletion or a replacement that Swarm can neither archive nor checkpoint does not run: the agent is told at once to name the paths in plain commands, or to copy the file before it replaces it.",
    refused:
      "Actions outside this computer's files do not run, because no checkpoint can undo them: a force push, a remote or cloud deletion, and shutting down or restarting the machine. Local actions that a checkpoint cannot cover, such as dropping database tables, flushing a data store or wiping a disk, do not run either. The agent is told at once to ask you through a decision or to list the step in its final message. Admin rights (sudo) and credential changes are skipped: the agent is told to carry on without that step, because sudo needs your password and cannot run unattended.",
    waits:
      "Every other action runs without asking, including network requests to any site, uploads of files from your computer, sending tokens and keys (also from environment variables), git push without force, deploying and publishing, writes outside the project folder, system services, stopping processes this session did not start, edits to tool and compiler config files, and commands or scripts Swarm does not recognise. You are not asked about any of these, so read the report when the mode is turned off.",
    secrets:
      "Secret and protected files may be read. Their values stay hidden as [hidden:NAME] from the agent, the report and exports.",
    report:
      "When the mode is turned off, a report is posted. It says what was done, what was decided, what was redirected to the archive method and what was refused, and it lists every send and its destination. Any report files are attached.",
    scope:
      "Turned on inside a session, this consent covers that session. Turned on with no session open, it covers the sessions of this folder that have no setting of their own. It lasts until the mode is turned off or Swarm restarts. You are asked again next time.",
    accept: "I agree, turn it on",
  },
  id: {
    title: "Nyalakan mode otonom?",
    intro:
      "Selama mode ini menyala, tidak ada yang menunggu Anda. Persetujuan di-*bypass* dan agen utama yang memutuskan, untuk Anda dan untuk subagennya. Setiap tindakan dijalankan, atau agen langsung menerima jawaban yang memberi tahu apa yang harus dilakukan sebagai gantinya, sehingga pekerjaan tidak pernah berhenti untuk bertanya kepada Anda. Tes, *build*, dan instalasi menjalankan kode proyek dan kode paketnya apa adanya, dan Swarm tidak memeriksa apa yang dilakukan kode itu. Setiap putusan dicatat di Aktivitas, termasuk tindakan yang tidak dijalankan.",
    archive:
      "Berkas dan folder yang dihapus Swarm dipindahkan ke arsip. Tindakan lokal yang tidak bisa dibatalkan, misalnya git reset --hard, git clean, atau menghapus *branch*, dijalankan setelah Swarm menyimpan titik pemulihan (*checkpoint*) berkas dan *ref* Git yang diubahnya, dan Anda dapat memulihkan titik itu nanti. Penghapusan atau penimpaan yang tidak bisa diarsipkan maupun dibuatkan titik pemulihan oleh Swarm tidak dijalankan: agen langsung diminta menyebut jalurnya dalam perintah biasa, atau menyalin berkas sebelum menimpanya.",
    refused:
      "Tindakan di luar berkas komputer ini tidak dijalankan, karena tidak ada titik pemulihan yang bisa membatalkannya: *force push*, penghapusan di *remote* atau *cloud*, serta mematikan atau memulai ulang mesin. Tindakan lokal yang tidak bisa dicakup titik pemulihan, misalnya menghapus tabel basis data, mengosongkan penyimpanan data, atau menghapus isi disk, juga tidak dijalankan. Agen langsung diminta bertanya kepada Anda melalui putusan atau mencantumkan langkah itu di pesan akhirnya. Hak admin (sudo) dan perubahan kredensial dilewati: agen diminta melanjutkan tanpa langkah itu, karena sudo memerlukan kata sandi Anda dan tidak bisa berjalan tanpa diawasi.",
    waits:
      "Semua tindakan lain berjalan tanpa bertanya, termasuk permintaan jaringan ke situs mana pun, *upload* berkas dari komputer Anda, pengiriman *token* dan kunci (juga dari variabel lingkungan), git push tanpa *force*, *deploy* dan *publish*, menulis di luar folder proyek, layanan sistem, menghentikan proses yang tidak dijalankan sesi ini, menyunting berkas konfigurasi alat dan kompiler, serta perintah atau *script* yang tidak dikenali Swarm. Anda tidak ditanya tentang semua itu, jadi bacalah laporannya saat mode dimatikan.",
    secrets:
      "Berkas rahasia dan berkas yang dilindungi boleh dibaca. Nilainya tetap disembunyikan sebagai [hidden:NAME] dari agen, laporan, dan ekspor.",
    report:
      "Saat mode dimatikan, laporan dikirim. Laporan itu memuat apa yang dikerjakan, apa yang diputuskan, apa yang dialihkan ke metode arsip, dan apa yang ditolak, serta mendaftar setiap pengiriman dan tujuannya. Berkas laporan yang dibuat ikut dilampirkan.",
    scope:
      "Jika dinyalakan di dalam sesi, persetujuan ini berlaku untuk sesi itu. Jika dinyalakan tanpa sesi yang terbuka, persetujuan ini berlaku untuk sesi di folder ini yang tidak punya pengaturan sendiri. Persetujuan berlaku sampai mode dimatikan atau Swarm dimulai ulang. Anda akan ditanya lagi lain kali.",
    accept: "Saya setuju, nyalakan",
  },
}
