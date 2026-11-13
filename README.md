# Swarm

Team handover (status, build, release, working rules; Bahasa Indonesia): see [HANDOVER.md](HANDOVER.md).

Release history 1.1.0 to 1.2.7 (Bahasa Indonesia): see [CHANGELOG.md](CHANGELOG.md).

Swarm is an on-device AI coding agent published by PT GSP: a command-line tool
with a terminal UI, plus a macOS desktop app. It runs against model providers you
configure yourself. The shipped defaults carry no account, no update server, and
no telemetry endpoint.

## What ships

| Item                | Value                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher           | PT GSP                                                                                                                                                                                                                          |
| Version             | `1.19.3`; security rebuilds are tagged `swarm/1.19.3-r<N>`                                                                                                                                                                      |
| Platform            | macOS on Apple silicon (arm64)                                                                                                                                                                                                  |
| CLI deliverable     | `swarm-darwin-arm64.zip`: the `swarm` binary, the local installer `install.sh`, the licence files `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.txt`, and the pre-install program `swarm-setup` with its lock and compose files |
| Desktop deliverable | `swarm-desktop-mac-arm64.dmg` and `.zip`, both holding `Swarm.app`                                                                                                                                                              |
| Signing             | ad-hoc signature only, no notarization                                                                                                                                                                                          |
| Updates             | none automatic; a patched release is a new build you reinstall from PT GSP distribution                                                                                                                                         |
| Model access        | nothing works out of the box; each release ships a frozen model list and a sample configuration you point at your own endpoint                                                                                                  |

## Install

There is no install URL. You obtain the archive from the PT GSP release handover.

1. Check every file against the release's `SHA256SUMS`, signed with the PT GSP
   release key, before running anything.
2. Install the CLI from inside the unpacked archive:

   ```bash
   unzip swarm-darwin-arm64.zip -d swarm-cli
   cd swarm-cli
   ./install.sh                    # takes ./swarm from this folder
   ./install.sh --binary ./swarm   # same thing, source stated explicitly
   ./install.sh --no-modify-path   # skip the shell PATH edit
   ```

   The installer copies the binary to `$HOME/.swarm/bin/swarm` and adds that
   directory to your shell startup file unless you pass `--no-modify-path`. It
   never contacts a network host.

3. Install the desktop app by opening the dmg and dragging `Swarm.app` into
   `/Applications`.
4. Want the optional supporting tools? Run `swarm-setup` from the CLI archive.
   It is a separate program, needs no administrator rights, and every tool
   starts unticked; the ones that can run as containers run in a dedicated
   container profile rather than directly on your machine.
5. macOS marks both deliverables quarantined because they are signed ad-hoc and
   are not notarized. After you have verified the checksums you may clear the
   attribute yourself:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Swarm.app
   xattr -d com.apple.quarantine "$HOME/.swarm/bin/swarm"
   ```

   Nothing in Swarm runs these commands for you. Clearing quarantine is your
   decision, taken after the hashes check out.

## First run

```bash
cd <your project>
swarm
```

`swarm --help` lists the commands. No model provider is reachable until you
configure one: the release ships a sample configuration with an empty address,
and the free hosted gateway that the upstream project offers is disabled here.

## Where to read next

| Topic                                                          | File                                            |
| -------------------------------------------------------------- | ----------------------------------------------- |
| Reporting a vulnerability, disclosure timing, supported builds | `SECURITY.md`                                   |
| Licence terms and attribution                                  | `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.txt` |

Swarm has no documentation site, community server, or hosted service of its own,
and no link to a third party's equivalents appears in this repository's
user-facing files.

## Repository notes

- The `README.*.md` translation files are upstream artifacts. They are not part
  of any Swarm build and are not maintained in this fork.
- Some internal identifiers keep their upstream spelling (workspace package
  names, data-file names, legacy environment variables) so the fork stays cheap
  to rebase onto future upstream tags. Everything user-visible - names, artifact
  files, configuration paths - is Swarm's own.
