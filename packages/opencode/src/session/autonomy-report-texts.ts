// The words of the autonomous run's end report (1.1.1, register S0.5), in the language the person used when they gave
// their consent. Headings only: what fills them comes from the record, and nothing here is ever sent to a model.

import type { Autonomy } from "@/permission/autonomy"

export interface Texts {
  readonly title: string
  readonly goal: string
  readonly result: string
  readonly done: string
  /** Each call the main agent decided, one per line (verifier M3). */
  readonly decisions: string
  /** Every action of the run that left, or would have left, the computer (P42). */
  readonly outward: string
  readonly files: string
  readonly archived: string
  /** 1.2.6 row 37b (N-080): the checkpoints saved before a call nothing could undo ran, by id. */
  readonly checkpointed: string
  /** 1.1.3: the class X calls answered with the archive method (`AutonomyTexts.ARCHIVE_REDIRECT`), not plain refusals. */
  readonly redirected: string
  readonly refused: string
  readonly waiting: string
  readonly todos: string
  readonly issues: string
  readonly attached: string
  /** `{ran}`, `{main}`, `{refused}` and `{waiting}` are filled with counts. */
  readonly summary: string
  // Labels inside sections. Not in S0.5, which registers headings; kept beside them so one file holds every word.
  readonly session: string
  readonly started: string
  readonly ended: string
  readonly agent: string
  readonly none: string
  readonly kinds: { readonly commands: string; readonly edits: string; readonly reads: string; readonly web: string; readonly other: string }
  readonly deciders: {
    readonly main: string
    readonly person: string
    readonly rules: string
    readonly forSubagentsAllowed: string
    readonly forSubagentsDeclined: string
  }
  readonly byKind: string
  readonly byDecider: string
  readonly skipped: string
  /** Why a document is listed and not attached (security L2, code review m5). */
  readonly notAttached: {
    readonly too_large: string
    readonly too_many: string
    readonly over_total: string
    readonly outside: string
    readonly link: string
  }
  /** The main agent's answer on one call. */
  readonly verdicts: { readonly allow: string; readonly reject: string; readonly defer: string }
  /** `{agent}` is the subagent's name. */
  readonly forSubagent: string
  /** 1.1.3: `{category}` is the category a call had before the consent changed it. */
  readonly previously: string
  /** `{n}` is how many more rows there are than the list shows. */
  readonly more: string
  /** What an outward action was (P42). */
  readonly outwardKinds: {
    readonly request: string
    readonly git_push: string
    readonly publish: string
    readonly image_push: string
    readonly deploy: string
    readonly other: string
  }
  /** What became of an outward action; the `*Later` ones waited for a person first. */
  readonly outwardVerdicts: {
    readonly ran: string
    readonly waited: string
    readonly refused: string
    readonly ranLater: string
    readonly refusedLater: string
  }
  /** A `git push` that names no remote goes to the branch's upstream. */
  readonly upstream: string
  /** `{tool}` is the publishing tool; no registry was named on the command. */
  readonly defaultRegistry: string
  readonly unknownDestination: string
  readonly failed: string
  readonly unavailable: string
  readonly stopped: string
  readonly queueFull: string
  /** 1.1.3 (T9): a call that ran and changed the repository's git settings or a git hook, which run later on the person's
   * own git commands, outside autonomous mode. */
  readonly gitSetup: string
}

export const TEXTS: Record<Autonomy.ReportLanguage, Texts> = {
  en: {
    title: "Autonomous run report",
    goal: "Goal",
    result: "Result (the main agent's last reply)",
    done: "What was done",
    decisions: "Decided by the main agent",
    outward: "Sent outside the computer",
    files: "Files changed",
    archived: "Moved to the archive",
    checkpointed: "Checkpointed",
    redirected: "Redirected to the archive method",
    refused: "Refused",
    waiting: "Still waiting for you",
    todos: "Work list",
    issues: "Open issues",
    attached: "Attached documents",
    summary:
      "Autonomous run report: {ran} steps ran, {main} decided by the main agent, {refused} refused, {waiting} still waiting for you. The full report is attached.",
    session: "Session",
    started: "Started",
    ended: "Ended",
    agent: "Main agent",
    none: "None.",
    kinds: { commands: "Commands", edits: "File changes", reads: "Reads", web: "Web", other: "Other" },
    deciders: {
      main: "Main agent",
      person: "You",
      rules: "Swarm's rules",
      forSubagentsAllowed: "For subagents, allowed",
      forSubagentsDeclined: "For subagents, declined",
    },
    byKind: "By kind",
    byDecider: "By who decided",
    skipped: "Not attached (listed only)",
    notAttached: {
      too_large: "larger than 10 MB",
      too_many: "more than 10 documents",
      over_total: "over the 25 MB total of one report message",
      outside: "not inside the project folder",
      link: "a link, which is not followed",
    },
    verdicts: { allow: "allowed", reject: "declined", defer: "left for you" },
    forSubagent: "for subagent {agent}",
    previously: "before the consent: {category}",
    more: "and {n} more",
    outwardKinds: {
      request: "request",
      git_push: "git push",
      publish: "package publish",
      image_push: "image push",
      deploy: "deploy",
      other: "other",
    },
    outwardVerdicts: {
      ran: "ran",
      waited: "waited for you",
      refused: "refused",
      ranLater: "waited, then ran",
      refusedLater: "waited, then refused",
    },
    upstream: "the branch's upstream remote",
    defaultRegistry: "the registry {tool} is set to use",
    unknownDestination: "not known",
    failed: "Failed",
    unavailable: "The main agent could not be reached",
    stopped: "Stopped for you",
    queueFull: "Too many calls were waiting",
    gitSetup: "Changed git settings or a git hook, which run later on your own git commands; please review",
  },
  id: {
    title: "Laporan sesi otonom",
    goal: "Tujuan",
    result: "Hasil (balasan terakhir agen utama)",
    done: "Yang dikerjakan",
    decisions: "Diputuskan oleh agen utama",
    outward: "Dikirim ke luar komputer",
    files: "*File* yang berubah",
    archived: "Dipindahkan ke arsip",
    checkpointed: "Disimpan sebagai checkpoint",
    redirected: "Dialihkan ke metode arsip",
    refused: "Ditolak",
    waiting: "Masih menunggu Anda",
    todos: "Daftar kerja",
    issues: "Masalah terbuka",
    attached: "Dokumen terlampir",
    summary:
      "Laporan sesi otonom: {ran} langkah dijalankan, {main} diputuskan oleh agen utama, {refused} ditolak, {waiting} masih menunggu Anda. Laporan lengkap terlampir.",
    session: "Sesi",
    started: "Mulai",
    ended: "Selesai",
    agent: "Agen utama",
    none: "Tidak ada.",
    kinds: { commands: "Perintah", edits: "Perubahan *file*", reads: "Pembacaan", web: "Web", other: "Lainnya" },
    deciders: {
      main: "Agen utama",
      person: "Anda",
      rules: "Aturan Swarm",
      forSubagentsAllowed: "Untuk subagen, diizinkan",
      forSubagentsDeclined: "Untuk subagen, ditolak",
    },
    byKind: "Menurut jenis",
    byDecider: "Menurut pemutus",
    skipped: "Tidak dilampirkan (hanya dicantumkan)",
    notAttached: {
      too_large: "lebih besar dari 10 MB",
      too_many: "lebih dari 10 dokumen",
      over_total: "melebihi total 25 MB untuk satu pesan laporan",
      outside: "tidak berada di dalam folder proyek",
      link: "berupa tautan, yang tidak diikuti",
    },
    verdicts: { allow: "diizinkan", reject: "ditolak", defer: "diserahkan kepada Anda" },
    forSubagent: "untuk subagen {agent}",
    previously: "sebelum persetujuan: {category}",
    more: "dan {n} lainnya",
    outwardKinds: {
      request: "permintaan",
      git_push: "git push",
      publish: "publikasi paket",
      image_push: "push image",
      deploy: "deploy",
      other: "lainnya",
    },
    outwardVerdicts: {
      ran: "dijalankan",
      waited: "menunggu Anda",
      refused: "ditolak",
      ranLater: "menunggu, lalu dijalankan",
      refusedLater: "menunggu, lalu ditolak",
    },
    upstream: "remote upstream cabang",
    defaultRegistry: "registry yang disetel untuk {tool}",
    unknownDestination: "tidak diketahui",
    failed: "Gagal",
    unavailable: "Agen utama tidak dapat dihubungi",
    stopped: "Dihentikan untuk Anda",
    queueFull: "Terlalu banyak panggilan menunggu",
    gitSetup: "Mengubah pengaturan git atau git hook, yang nanti berjalan pada perintah git Anda sendiri; mohon periksa",
  },
}

/** A category's words as the app shows them (S0.4 category column). One not listed is shown by its name. */
export const CATEGORY: Record<Autonomy.ReportLanguage, Readonly<Record<string, string>>> = {
  en: {
    irreversible: "Can't be undone, so it is never run",
    admin_rights: "Needs admin rights (sudo), so it is never run",
    outside_write_held: "Writes outside the project folder",
    system_service: "Changes a system service",
    process_not_own: "Stops a process Swarm did not start",
    unreadable_command: "Swarm could not read this command well enough",
    by_main_agent: "You agreed that the main agent decides during this run",
    delete_compound: "A deletion mixed with other commands",
    credential_change: "Changes a remote, a credential or a git account",
    script_flagged: "A script that needs a closer look",
    archived: "Moved to the archive instead of deleted",
    not_reversible: "Deletes or replaces something Swarm could not archive first",
    checkpointed: "Swarm saved a checkpoint first, then it ran",
    checkpoint_failed: "Swarm could not save a checkpoint first, so it did not run",
  },
  id: {
    irreversible: "Tidak bisa dibatalkan, jadi tidak pernah dijalankan",
    admin_rights: "Butuh hak admin (sudo), jadi tidak pernah dijalankan",
    outside_write_held: "Menulis di luar folder proyek",
    system_service: "Mengubah layanan sistem",
    process_not_own: "Menghentikan proses yang tidak dijalankan Swarm",
    unreadable_command: "Swarm tidak bisa membaca perintah ini dengan cukup jelas",
    by_main_agent: "Anda setuju agen utama yang memutuskan selama sesi ini",
    delete_compound: "Penghapusan yang dicampur perintah lain",
    credential_change: "Mengubah remote, kredensial, atau akun git",
    script_flagged: "Skrip yang perlu diperiksa lebih dulu",
    archived: "Dipindahkan ke arsip, bukan dihapus",
    not_reversible: "Menghapus atau mengganti sesuatu yang tidak bisa diarsipkan Swarm lebih dulu",
    checkpointed: "Swarm menyimpan checkpoint dulu, lalu menjalankannya",
    checkpoint_failed: "Swarm tidak bisa menyimpan checkpoint dulu, jadi tidak dijalankan",
  },
}

export function summary(language: Autonomy.ReportLanguage, counts: { ran: number; main: number; refused: number; waiting: number }) {
  return TEXTS[language].summary
    .replace("{ran}", String(counts.ran))
    .replace("{main}", String(counts.main))
    .replace("{refused}", String(counts.refused))
    .replace("{waiting}", String(counts.waiting))
}

export * as AutonomyReportTexts from "./autonomy-report-texts"
