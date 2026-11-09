# Swarm - Dokumen Handover Tim

Status per 2026-11-09. Branch `swarm/main`, HEAD `dd2a88c583`, sudah di-push ke remote privat `gsp`
(https://github.com/sixer0/SwarmOnDevice). Dokumen ini ringkasan untuk developer yang melanjutkan pekerjaan.

Catatan sumber: proses build, rilis, dan log keputusan **tidak ada di repo ini**. Semuanya ada di folder
`/Users/gsp-budi/Swarm_OnDevice/docs/` dan `/Users/gsp-budi/Swarm_OnDevice/tools/` **di build Mac saja** (tidak
di GitHub). Rujukan berbentuk `docs/...` di bawah menunjuk ke folder itu. Minta salinannya ke owner bila Anda
bekerja di mesin lain.

---

## 1. Apa itu Swarm

Swarm adalah AI coding agent on-device yang diterbitkan PT GSP: CLI dengan terminal UI (`swarm`) plus desktop
app macOS (`Swarm.app`, Electron). Swarm adalah turunan independen dari OpenCode (fork dari rilis v1.19.3, commit
`e3c4eb2425`, lisensi MIT; lihat `NOTICE` dan `LICENSE`). Default bawaan tidak membawa akun, update server, atau
telemetry. Model dijalankan lewat provider yang dikonfigurasi pengguna; desktop app menawarkan provider internal
"GSP AI" (tanpa key bawaan). Di atas inti OpenCode, Swarm menambahkan agen spesialis dengan tier model, workflow
multi-langkah (`swarm-workflow`), Mission Control, DATUM Studio (dokumen dan diagram house style GSP), mode
otonom dengan protected paths, dan program pra-instalasi `swarm-setup`. Sumber: `README.md`, `NOTICE`.

---

## 2. Status rilis saat ini

| Item | Status | Sumber |
|---|---|---|
| macOS desktop 1.2.2 | Build dari `dd2a88c583`, 30/30 gate PASS, terinstal di `/Applications/Swarm.app` di build Mac | `docs/2026-11-05_swarm_linux_installer_patcher/decisions/decisions.md` L74, `implementation/204_macos_build.md` |
| Nomor versi | Release Swarm `1.2.2` (`SWARM_RELEASE`, `packages/desktop/electron-builder.config.ts:113`, `packages/desktop/package.json`). Versi CLI/upstream pin tetap `1.19.3` (`packages/opencode/package.json`, `README.md`) | repo |
| dmg | `swarm-desktop-mac-arm64.dmg`, sha256 diawali `3453f5589264e147` (cocok dengan `SHA256SUMS` dan dihitung ulang) | `implementation/204_macos_build.md` |
| Push | `swarm/main` -> `gsp` main (`--force-with-lease` atas initial commit GitHub). `origin` (upstream OpenCode) push DISABLED | decisions L76 |
| Linux `.deb` | Riset + spesifikasi selesai, sebagian kode target-aware sudah masuk (`SWARM_BUILD_TARGET`). **ON HOLD** sampai owner menyetujui | decisions L38 |
| Windows `.exe` (NSIS x64, unsigned) | Riset + spesifikasi selesai, sebagian kode sudah masuk. **ON HOLD** | decisions L38, L43 |
| Patcher Linux/Windows (M2, rows 150-160) | Ditunda ke rilis berikutnya | decisions L14 |

### Yang tersisa untuk Linux/Windows (dihentikan per L38)

- Rows 172 (node-pty alias per target), 177, 123 (5 perubahan kode Windows Studio), 130/131 (recipe Linux/Windows),
  178, 137/138 (build), 139-141 (tes colima terpisah), UAT 144/145.
- Code review follow-up (L43): F1 folder misi Windows (`C:\...`) ditolak store; F2 tidak ada paket Windows dari
  commit ini sebelum row 123 masuk; F3 satu pembaca `SWARM_BUILD_TARGET` (`scripts/prebuild-target.ts`) untuk
  `check-datum-stage` dan `stage-datum-studio`; F4 tes bersama aturan folder/session-id/limit 50; F5-F9 cleanup kecil.
- Batasan yang sudah dinamai di register (`docs/.../masterplan/00_register.md` R12): `LIM-L1` (deb tidak menaruh
  `swarm` di PATH), `WL-1`..`WL-4` (Windows: render bridge DATUM tidak jalan karena Python tanpa `AF_UNIX`, tidak ada
  ekspor PNG diagram, `swarm run` tidak attach ke app, CLI tidak di PATH).
- Nama artifact yang sudah ditetapkan: `swarm-desktop-linux-amd64.deb`, `swarm-desktop-win-x64.exe`; folder output
  `tools/build/desktop_linux_<commit>` dan `desktop_win_<commit>` (register R3.2, R3.3, R3.6).

---

## 3. Fitur utama

| Fitur | Ringkasan | File kunci |
|---|---|---|
| Agen dan tier | Primary: `build`, `plan`. Subagent bawaan: `general`, `explore`, `coder`, `planner`, `verifier`, `data-collector`, `document-writer`; `researcher` hanya muncul bila server MCP swarm-web terpasang | `packages/opencode/src/agent/agent.ts`, `agent/prompt/*.txt`, `session/system.ts:120` |
| Tier GSP AI | `thinker` (planner, verifier), `worker` (general, coder, document-writer), `worker-fast` (explore, data-collector). Tidak ada argumen model; Swarm yang menetapkan | `packages/desktop/src/main/bundled-provider.ts` |
| Role alias | Nama peran dari workflow lain (mis. `task-architect`, `coder-execution`, `security-review`) dipetakan ke agen Swarm; alias tidak bisa memperluas izin target | `packages/opencode/src/agent/role-alias.ts` |
| swarm-workflow | Skill bawaan untuk pekerjaan multi-langkah: identifikasi, plan tabel, approval, mission rows, delegasi, verifikasi, close. Dimuat otomatis lewat aturan `auto_workflow` | `packages/opencode/src/skill/swarm-workflow.md`, `session/prompt/auto-workflow.txt`, `session/prompt/swarm-rules.txt` |
| Mission Control | Misi multi-langkah dengan baris per langkah, keputusan, dan deliverable; dipantau di Aktivitas -> Agen. Agen tidak pernah menjawab keputusan (deny final pada `studio_mission_answer_decision`) | `packages/opencode/src/skill/mission-control.md`, `packages/desktop/datum/PANDUAN_MISSION_CONTROL.md` |
| Studio / DATUM | DATUM Studio (dokumen, figure, verification gate) di-host oleh desktop app sebagai MCP server `datum-studio`; skill `datum-house-style` | `packages/datum-studio/`, `packages/desktop/datum/` |
| Mode otonom | Setting nyata per sesi (model tidak bisa menyalakannya). Bila on: self-approval tercatat terbuka; file tool boleh baca/tulis di luar proyek tanpa prompt, kecuali protected paths; penghapusan dipindah ke `.swarm/archive` | `packages/opencode/src/permission/autonomy-table.ts`, `autonomy-texts.ts`, `bypass-lists.ts:305-329` |
| Protected paths | Tidak pernah dibuka di mode otonom: `~/.ssh`, `~/.gnupg`, `~/.aws`, keychain, `~/.swarm-patch-key`, `auth.json`/`mcp-auth.json`, dll; folder sistem dan `/Applications/Swarm.app` tidak pernah ditulis | `packages/opencode/src/permission/bypass-lists.ts:313-329` |
| Teks PDF | Model tanpa input PDF (GSP AI) menerima teks hasil ekstraksi dengan penanda halaman; tanpa dependency baru | `packages/opencode/src/util/pdf-text.ts` |
| Vision | `thinker`, `worker`, `worker-fast` dideklarasikan menerima gambar (`modalities.input: text, image`) | `bundled-provider.ts`, decisions L68 |
| SWARM.md | File instruksi milik Swarm (global dan proyek), lihat bagian 9 | `packages/opencode/src/session/instruction.ts:74-95` |
| claude_compat | Default off. Bila on (config global saja), Swarm juga membaca `~/.claude/CLAUDE.md`, `CLAUDE.md` proyek, dan skill `.claude/skills` | `instruction.ts`, `skill/index.ts:403` |
| Knowledge library | Prosedur dan pengetahuan teknis yang dibawa desktop app (skill `knowledge-library`), hanya bila Settings > Knowledge Library on | `skill/swarm-workflow.md` bagian 0 |
| swarm-setup | Program pra-instalasi terpisah, unprivileged, consent-first, untuk tool opsional | `packages/setup/README.md` |

---

## 4. Struktur repo

Package yang relevan untuk Swarm (nama workspace banyak yang masih ejaan upstream `@opencode-ai/*`, sengaja,
agar rebase ke upstream murah; `README.md` "Repository notes").

| Path | Nama package | Isi |
|---|---|---|
| `packages/opencode` | `opencode` | CLI dan agent core: agent, session, permission, tool, skill, server, prompt |
| `packages/desktop` | `@opencode-ai/desktop` | Electron app, `electron-builder.config.ts`, script stage/check/prebuild, DATUM resources, bundled provider |
| `packages/app` | `@opencode-ai/app` | UI SolidJS (dipakai desktop), termasuk Mission Control view dan settings |
| `packages/datum-studio` | `@swarm/datum-studio` | Salinan Studio vendored (`vendor/`, provenance), adapter lokal, mission store, MCP host |
| `packages/core` | `@opencode-ai/core` | Logika inti bersama (agent, config, database, catalog) |
| `packages/setup` | `@swarm/setup` | `swarm-setup`, program pra-instalasi |
| `packages/tui` | `@opencode-ai/tui` | Komponen terminal UI |
| `packages/sdk` | (`js/`, `openapi.json`) | SDK JavaScript lama dan OpenAPI; regenerasi lewat `./packages/sdk/js/script/build.ts` |
| `packages/ui`, `session-ui` | `@opencode-ai/ui` dll | Komponen UI bersama |
| `packages/schema`, `protocol`, `client`, `server`, `llm`, `plugin`, `cli`, `sdk-next` | `@opencode-ai/*` | Lapisan kontrak/server/provider dari upstream (aturan dependensi di `AGENTS.md`) |
| `packages/console`, `web`, `enterprise`, `slack`, `stats`, `function`, `identity`, dll | upstream | Warisan upstream; peran di build Swarm belum diverifikasi |

Dokumen di root: `README.md` (rilis dan instalasi), `SECURITY.md` (pelaporan kerentanan), `NOTICE` (atribusi),
`AGENTS.md` (style guide kode, berlaku), `CONTEXT.md` (bahasa domain session runtime). `CONTRIBUTING.md` masih
teks upstream OpenCode; untuk Swarm yang berlaku adalah dokumen ini dan `AGENTS.md`.

---

## 5. Setup developer

| Item | Nilai |
|---|---|
| Bun | `1.3.14` (`package.json` -> `packageManager: bun@1.3.14`); hook `.husky/pre-push` memeriksa versi ini |
| Lokasi bun di build Mac | `/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin/bun` (tidak ada `~/.bun`) |
| Shell | zsh: variabel tanpa quote tidak di-word-split; pakai path absolut |

```bash
export PATH=/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin:$PATH
cd /Users/gsp-budi/Swarm_OnDevice/swarm
bun install            # hanya bila Anda memang pemilik perubahan lockfile
bun dev                # CLI/TUI dari source (packages/opencode)
bun run dev:desktop    # desktop app dev (lihat aturan isolasi di bagian 8)
```

### Menjalankan test (HOME dan XDG di-pin)

Test tidak boleh dijalankan dari root repo (guard `do-not-run-tests-from-root`, `AGENTS.md`). Selalu dari folder
package, dengan HOME/XDG di folder sementara supaya data asli tidak tersentuh:

```bash
T=$(mktemp -d "${TMPDIR:-/tmp}/swarmtest.XXXXXX")
mkdir -p $T/home $T/xdg/{cache,config,data,state}
export HOME=$T/home XDG_CACHE_HOME=$T/xdg/cache XDG_CONFIG_HOME=$T/xdg/config \
       XDG_DATA_HOME=$T/xdg/data XDG_STATE_HOME=$T/xdg/state
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
       NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
cd /Users/gsp-budi/Swarm_OnDevice/swarm/packages/opencode && bun test --timeout 30000
```

Pastikan bun tetap ada di PATH (tanpa itu test subprocess gagal dengan `Executable not found in $PATH: "bun"`,
`implementation/197_s194_fixes.md`). Test yang bind port perlu sandbox off; pakai port 47xxx/55xxx.

### Typecheck

```bash
cd packages/opencode && bun typecheck                       # per package, jangan panggil tsc langsung
cd /Users/gsp-budi/Swarm_OnDevice/swarm && bun turbo typecheck --force   # semua: harapan 32/32 successful
```

Setelah mengubah API server/SDK: `./script/generate.ts` (root) atau `bun run generate` di `packages/client`
(`AGENTS.md`, `CONTRIBUTING.md`).

---

## 6. Build dan rilis macOS

Recipe: `docs/2026-11-05_swarm_linux_installer_patcher/implementation/26u_build_1_2_2_dd2a88c583.zsh` (526 baris,
build Mac saja). Laporan run: `implementation/204_macos_build.md`, log `26u_build_gates.log`, `26u_build.stdout`.

### Ringkasan recipe

1. Variabel tetap: `RELEASE=1.2.2`, `OPENCODE_VERSION=1.19.3`, `OPENCODE_CHANNEL=prod`, `SWARM_BUILD_TARGET` di-unset
   (= darwin-arm64), Electron zip dan models snapshot dari `tools/cache`, XDG ke `tools/xdg`, semua proxy ke
   `127.0.0.1:9` (build offline), token (GitHub, NPM, Sentry, CSC) di-unset.
2. `BUILD_COMMIT` dan `OUT=$R/tools/build/desktop_<BUILD_COMMIT>` harus diisi; recipe menolak jalan bila HEAD beda.
3. Gate pra-build (9): `PRE-TOOLS`, `PRE-C37`, `PRE-OUT`, `PRE-HDIUTIL`, `BG-1` (working tree bersih),
   `BG-2` (hash file setup terkunci), `BG-3`, `BG-4` (import/referensi `tools.lock`), `BG-5` (hash `rg`).
4. Lock `tools/build/.candidate_build.lock` (satu build sekaligus).
5. Stage: `scripts/stage-cli.ts` -> `stage-datum-runtime.ts --offline` -> `stage-datum-studio.ts`, lalu
   `bun run build` dan `bun run package:mac --arm64 --publish never`.
6. Gate pasca-build (20): `INT-B1`, `OUT-FRESH`, `INT-B2`, `CODESIGN`, `PATCH-1`, `NOPYC-1`, `MACHO-1`,
   `RT-MANIFEST`, `SZ-1`, `SZ-2`, `SKILL-1`, `SZ-3`, `SZ-3a`, `SZ-3b`, `SZ-3c`, `SZ-4`, `SZ-5`, `SHA256`, `SZ-6`, `SMOKE-1`.
7. Folder stage dibersihkan, lalu `BG-6` (tree tetap bersih, HEAD tidak berubah). Total 30 gate.
   Baris terakhir yang diharapkan: `CANDIDATE_BUILD PASS <commit> <OUT>`.

### Menjalankan untuk commit baru

```bash
cd /Users/gsp-budi/Swarm_OnDevice/docs/2026-11-05_swarm_linux_installer_patcher/implementation
cp 26u_build_1_2_2_dd2a88c583.zsh 26v_build_<release>_<commit>.zsh
# edit hanya: header, BUILD_COMMIT=<10 hex>, OUT=$R/tools/build/desktop_<commit> (sama seperti 26t -> 26u)
zsh 26v_build_<release>_<commit>.zsh gates   # harus "GATES failed 0"
zsh 26v_build_<release>_<commit>.zsh build   # sandbox off: hdiutil butuh itu
```

Syarat: working tree bersih (`git status --porcelain` kosong), tidak ada lock, tidak ada yang mengedit repo selama build.

### Output (`tools/build/desktop_<commit>/`)

`swarm-desktop-mac-arm64.dmg` (+ `.blockmap`), `swarm-desktop-mac-arm64.zip` (+ `.blockmap`), `SHA256SUMS`,
`mac-arm64/Swarm.app`, dan log `desktop_<commit>.{build,cli-stage,datum-runtime-stage,datum-studio-stage,package}.log`
di sebelahnya. Signing hanya ad-hoc, tanpa notarization (`README.md`).

### Verifikasi dan install

```bash
OUT=/Users/gsp-budi/Swarm_OnDevice/tools/build/desktop_<commit>
(cd $OUT && shasum -a 256 -c SHA256SUMS)
# 1. Owner keluar dari Swarm dulu (jangan install saat app berjalan).
# 2. App lama dipindah ke Trash dengan nama yang jelas - jangan pernah dihapus:
mv /Applications/Swarm.app ~/.Trash/"Swarm 1.2.2 build <commit_lama> (replaced).app"
# 3. Mount dmg read-only, salin app, lepas mount:
hdiutil attach -readonly -nobrowse -mountpoint $TMPDIR/swarmdmg $OUT/swarm-desktop-mac-arm64.dmg
ditto $TMPDIR/swarmdmg/Swarm.app /Applications/Swarm.app
hdiutil detach $TMPDIR/swarmdmg
# 4. Cek versi dan signature:
plutil -extract SwarmRelease raw /Applications/Swarm.app/Contents/Info.plist
plutil -extract CFBundleShortVersionString raw /Applications/Swarm.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Swarm.app && echo codesign OK
```

Perintah di atas adalah contoh yang mengikuti langkah yang tercatat (L46, L69, L74: mount read-only, app lama ke
Trash, cek `SwarmRelease`/`CFBundleShortVersionString` dan codesign); urutan persisnya di build Mac ada di laporan
implementation masing-masing. Data pengguna (`~/.local/share/swarm`, `~/.config/swarm`) tidak disentuh saat install.
Bundle `Swarm.app` di folder build dipindah ke Trash setelah install supaya Spotlight hanya menemukan
`/Applications/Swarm.app` (L66); dmg, zip, dan `SHA256SUMS` tetap disimpan sebagai bukti.

---

## 7. Testing

| Package | Perintah (dari folder package) | Hasil terakhir | Baseline gagal yang diketahui |
|---|---|---|---|
| `opencode` | `bun test --timeout 30000` | 6890 pass, 31 skip, 1 todo, 1 fail | `test/cli/cmd/uninstall.test.ts:70` (`collectRemovalTargets`) |
| `desktop` | `bun test` | 1228 pass, 16 skip, 1 fail | `No such built-in module: node:sqlite` |
| `core` | `bun test` | 1168 pass, 0 fail | - |
| `app` | `bun run test:unit` / `bun run test:browser` | 1378 / 72 pass, 0 fail | - |
| `datum-studio` | `bun test` | 4456 pass, 120 skip, 0 fail | - |
| root | `bun turbo typecheck --force` | 32/32 successful | - |

Sumber angka: `docs/2026-11-05_swarm_linux_installer_patcher/implementation/197_s194_fixes.md` bagian 5. Setelah
itu row 202 (commit `dd2a88c583`) melaporkan suite permission/terkait 1653 pass dengan 6 baseline yang sensitif
terhadap HOME, sama dengan di `f6532222c6` (decisions L73). Full suite pada `dd2a88c583` sendiri belum tercatat
di dokumen yang dibaca; jalankan ulang sebelum rilis berikutnya.

Aturan: targeted test di setiap perubahan, full suite sekali per commit rilis. Hindari mock dan `globalThis`
(`AGENTS.md`). Baseline gagal di atas bukan regresi; kegagalan lain adalah regresi.

---

## 8. Aturan kerja dan keamanan

### Git dan remote

| Aturan | Detail |
|---|---|
| Upstream | `origin` = OpenCode upstream, push-nya DISABLED. Jangan pernah push atau membuka PR ke upstream |
| Remote Swarm | `gsp` = https://github.com/sixer0/SwarmOnDevice (privat). Push hanya atas permintaan eksplisit owner (L76) |
| Commit | Conventional commits `type(scope): summary` (`AGENTS.md`). Hook pre-push menjalankan cek versi bun dan `bun typecheck` |
| File | Jangan menghapus atau me-rename file yang tidak diminta; pindahkan ke samping atau ke Trash |

### Patch key

Paket patch sistem (`.swarmpatch`) ditandatangani **hanya oleh owner**, secara manual di jendela Terminal terpisah.
`scripts/swarm-patch-release.ts make` hanya menulis folder kerja tanpa tanda tangan plus `sign_command.txt`;
`seal` hanya memverifikasi signature terhadap `allowed_signers` di app. Tool tidak pernah membaca kunci privat.
Developer dan agen tidak pernah membaca, menyalin, atau memakai `~/.swarm-patch-key`.

### Isolasi saat menjalankan test atau app

- HOME dan semua `XDG_*` di folder sementara; proxy ke `127.0.0.1:9`; `NO_PROXY` untuk loopback.
- Electron `appData` mengabaikan HOME, dan `--user-data-dir` saja tidak cukup (`packages/desktop/src/main/index.ts`
  mereset userData). Untuk menjalankan app dev atau hasil build secara terisolasi: `env -i` dengan HOME/XDG fixture,
  `OPENCODE_TEST_ONBOARDING_ROOT` ke folder fixture, `--use-mock-keychain` (atau
  `app.commandLine.appendSwitch("use-mock-keychain")` sebelum ready), dan script pembungkus dengan trap
  EXIT/INT/TERM yang selalu menghentikan PID app Anda sendiri.
- Setiap run Chromium/headless shell di bawah HOME fixture juga wajib `--use-mock-keychain`; tanpa itu macOS
  menampilkan dialog "Keychain Not Found".
- Jangan menyentuh data asli: `~/.local/share/swarm`, `~/.config/swarm`, `~/.swarm`, `~/.colima`, `~/.claude`,
  `/Applications/Swarm.app` (tulis), atau Swarm yang sedang berjalan.
- Satu build sekaligus (lock); jangan mengedit repo saat build berjalan.

Sumber: `docs/2026-11-06_swarm_1_2_0_datum_installer/delegation_progress/driver_rules.md`.

### GSP AI

- Provider bawaan `gsp-ai-tail` (`bundled-provider.ts`) tidak membawa key. Key dimasukkan pengguna lewat connect
  flow dan disimpan di `auth.json` di folder data Swarm. Jangan pernah mencetak, me-log, atau meng-commit key.
- Alamat endpoint ada di `bundled-provider.ts`; jangan menyalinnya ke dokumen lain atau ke layanan luar.
- **Tidak ada panggilan model di test.** Pengecualian hanya replay yang disetujui owner secara eksplisit: prompt
  sintetis (tanpa isi repo atau data pribadi), salinan key di fixture yang dihapus setelah run, dan leak check
  yang hanya menghitung kecocokan (contoh: decisions U15 di task 1.2.0, row 193 replay).

### Pelaporan kerentanan

Ikuti `SECURITY.md`. Alamat kontak keamanan masih placeholder `[[SWARM_SECURITY_CONTACT]]`; selama belum diisi,
build Swarm tidak boleh didistribusikan ke luar PT GSP (aturan R-15 yang dikutip `SECURITY.md`).

---

## 9. Konfigurasi pengguna

### Urutan instruksi

1. Aturan bawaan Swarm (`session/prompt/swarm-rules.txt`); tidak bisa dilonggarkan oleh file mana pun.
2. Global: `~/.config/swarm/SWARM.md`, lalu `~/.config/swarm/AGENTS.md`; ditambah `~/.claude/CLAUDE.md` hanya bila
   `claude_compat` on. Swarm tidak pernah membuat atau mengubah `SWARM.md`.
3. Proyek: nama pertama yang ditemukan menang: `SWARM.md`, lalu `AGENTS.md`, lalu `CLAUDE.md` (hanya bila
   `claude_compat` on), lalu `CONTEXT.md` (deprecated).

Sumber: `packages/opencode/src/session/instruction.ts:74-95, 150`; `PANDUAN_MISSION_CONTROL.md`.

### Skill

- Skill buatan pengguna: `~/.config/swarm/skills/<nama>/SKILL.md` (pola `{skill,skills}/**/SKILL.md` di direktori
  config, `skill/index.ts:30`). Folder `.agents/skills` (global dan proyek) juga dipindai.
- `skills.paths` dan `skills.urls` di config menambah lokasi lain.
- Skill bawaan (`swarm-workflow`, `mission-control`, `datum-house-style`, `knowledge-library`, `customize-swarm`)
  dicadangkan namanya; salinan di disk dengan nama sama tidak menggantikannya.

### claude_compat

- Default off; hanya dari config global (`~/.config/swarm/swarm.json`), config proyek tidak bisa menyalakannya.
- UI: Pengaturan -> Umum -> Kompatibilitas Claude Code (berlaku mulai pesan berikutnya).
- Bila on: `~/.claude/CLAUDE.md`, `CLAUDE.md` proyek, dan skill di `~/.claude/skills` / `.claude/skills` ikut dibaca.
  Swarm tidak pernah menulis, memindahkan, atau menghapus isi `~/.claude`.

### Mode otonom

Pengaturan -> Umum -> Mode otonom, atau penanda di kolom prompt. Batas biaya, aturan izin, dan tindakan yang sulit
dibatalkan tetap menunggu pengguna (`PANDUAN_MISSION_CONTROL.md` bagian 4).

---

## 10. Known limits dan follow-up

| # | Item | Sumber |
|---|---|---|
| 1 | PDF: hanya teks, tanpa gambar halaman. Gambar halaman butuh dependency baru (pdf.js) atau operasi baru di render bridge: keputusan owner. Halaman scan dan file terenkripsi tidak menghasilkan teks | decisions L72, `util/pdf-text.ts:6-8` |
| 2 | Vision GSP AI belum diverifikasi terhadap endpoint live (tidak ada panggilan model) | L68 |
| 3 | Mode otonom: baca di bawah folder sistem tetap boleh; `apply_patch` dan `grep` di luar proyek masih bertanya; overwrite di luar proyek tidak punya Undo; aturan shell tidak diperluas | L73 |
| 4 | S186-03 / S194-02: Mission Control perlu agent id sendiri (mis. `swarm-mc`) agar store hanya menerima `by: user` darinya. Direncanakan 1.2.3 | L42, `implementation/197_s194_fixes.md` |
| 5 | Folder misi Windows (`C:\...`) ditolak store (F1, S186-04); harus diperbaiki sebelum build Windows atau disebut di release note | L42, L43 |
| 6 | Baris Linux/Windows (lihat bagian 2) dan patcher M2 (rows 150-160) masih ditahan | L14, L38 |
| 7 | Limits yang sudah dinamai: `LIM-L1`, `WL-1`..`WL-4` | register R12 |
| 8 | Bundle desktop mengambil node-pty dari host build (row 172 belum jalan) | L18 |
| 9 | Agen masih sering kena penolakan skema blok diagram (14-26 per run); perbaiki panduan dan error diagram | report 1.2.0/1.2.1 bagian Open |
| 10 | Batas lama 1.2.1: garis tepi halaman PDF 0,265 mm, kicker DOCX 7,5 pt, nomor halaman daftar isi tidak tercetak di PDF; baris di luar Studio (XLSX via Python) tidak di-gate | `docs/2026-11-06_swarm_1_2_0_datum_installer/report/report.md` |
| 11 | Kontak keamanan di `SECURITY.md` masih placeholder | `SECURITY.md` |
| 12 | `CONTRIBUTING.md` dan file `README.*.md` terjemahan masih teks upstream | `README.md` |
| 13 | Full test suite belum tercatat pada `dd2a88c583` (lihat bagian 7) | - |

---

## 11. Kontak dan ownership

| Peran | Nilai |
|---|---|
| Publisher | PT GSP (PT Gemilang Satria Perkasa) |
| Maintainer (deb `Maintainer:`) | `PT Gemilang Satria Perkasa <gemilangsatriaperkasa.eng@gmail.com>` (register R7.4, `electron-builder.config.ts:139`) |
| Homepage | https://www.gemilangsatriaperkasa.co.id/ (register R7.5) |
| Owner repo GitHub | akun `sixer0` (repo privat `SwarmOnDevice`) |
| Kontak keamanan | belum ditentukan (placeholder di `SECURITY.md`) |
| Pemegang patch signing key | owner; identitas formal belum ditentukan di repo |

---

## 12. Glosarium singkat

| Istilah | Arti |
|---|---|
| thinker / worker / worker-fast | Tier model GSP AI: penilaian dan review / kerja umum / kerja mekanis cepat |
| Row | Satu langkah di blueprint/plan; juga satu baris di Mission Control |
| Mission Control | Panel misi di Aktivitas -> Agen; store-nya di `packages/datum-studio` |
| Studio, DATUM | DATUM Studio: pembuat dokumen dan figure house style GSP dengan verification gate |
| Verification gate | `studio_report_check` lalu `studio_report_submit`; output baru "done" bila lolos |
| Mode otonom | Setting sesi yang mengizinkan self-approval tercatat dan akses file di luar proyek (kecuali protected paths) |
| Protected path | Lokasi yang tidak pernah dibuka file tool di mode otonom (kunci, kredensial, folder sistem, app Swarm) |
| claude_compat | Setting global untuk ikut membaca file Claude Code (`CLAUDE.md`, `.claude/skills`) |
| SWARM.md | File instruksi milik Swarm (global atau proyek) |
| `SWARM_BUILD_TARGET` | Target build: `darwin-arm64` (default bila kosong), `linux-x64`, `win32-x64` |
| Gate (build) | Cek pass/fail di recipe; 30 gate untuk macOS |
| L<n>, U<n>, C<n> | ID keputusan di `decisions.md` (build Mac) |
| `.swarmpatch` | Paket patch sistem bertanda tangan owner |
| `swarm-setup` | Program pra-instalasi tool opsional, terpisah dari app |
