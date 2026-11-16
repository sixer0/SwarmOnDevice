# Spike harness S1 / S1v / S2 (plan row 32, M0-03)

Throwaway code for the SG-1 spikes in test strategy §8 (SP-S1, SP-S1v = ST-10, SP-S2).
Built by row 32; **run** by rows 35 (S1, S1v), 36 (S2) and torn down by row 39, with the
user present. Nothing here is production code, and nothing here is imported by `src/`.

| File | Purpose |
|---|---|
| `gen-certs.ts` | Generates the register §6.1 name-constrained CA, the `localhost` leaf and the out-of-constraint `example.com` leaf (ST-10) with `pkijs` + `asn1js`, plus placeholder icons. Writes only to its output directory. Runs no process and never touches the keychain |
| `icons.ts` | Solid-colour PNG encoder for the 32/64 px placeholder icons |
| `server.ts` | HTTPS server: `127.0.0.1:46317` and `[::1]:46317` (localhost leaf), `127.0.0.1:46318` (example.com leaf). Access log with address family in `<out>/access.log` |
| `/s3/`, `/s3/index.html`, `/s3/pane.js` | Row 32a: serves `../s3/index.html` and `../s3/pane.js` (no-store; register §4.1 RC-6 CSP, row 32b; `/pane/` has no CSP). The register has no `frame-ancestors` value yet (O7/G11); for row 37 set `SPIKE_S3_FRAME_ANCESTORS="<sources>"` when starting `server.ts` to append one, and record each value tried. Reach it in Office via the link at the bottom of the hello pane (manifests unchanged) |
| `GET /s3/next`, `POST /pane/log` | Row 33b (C20): command channel for the S3 pane. `/s3/next` pops the first non-empty line of `<out>/s3-queue.txt` (created if missing; read, temp write, `rename()`), returns `{"cmd": "<line>"}` or `{"cmd": null}` with no-store and the `/s3/*` CSP, and logs only dispatches (`s3-dispatch`). `/pane/log` logs bodies up to 256 KiB whole as `pane-report` (with `bytes`), 413 above. Usage: `echo "W1" >> $OUT/s3-queue.txt`, results in `$OUT/access.log`; full syntax in `../s3/README.md` |
| `pane/index.html` | Hello pane: loads Office.js from the RC-1 URL, `Office.onReady`, shows and POSTs host + platform |
| `manifest-s1.xml` | S1: `TaskPaneApp`, `Document` only, version `1.0.0.0` |
| `manifest-s2.xml` | S2: `Document` + `Workbook`, no `<Requirements>`, version `1.0.0.1` |
| `tsconfig.json` | Maps `pkijs`/`asn1js` to `packages/desktop/node_modules` (Bun honours `paths` at runtime too) |

Spike manifest Id: `304f5229-945e-49cf-ab5f-46f1d93d1546` (not the production Id
`b25aaa4e-...` from register §6.2). Both spike manifests share it, so S2 replaces S1 in place;
the version bump avoids a stale Office cache entry. The wef filename is
`swarm-office-spike.xml`, never the production `swarm-office-addin.xml`.

Spike CA subject CN: `Swarm Office Add-in Local CA (spike)`. It contains the register CN as a
substring, so the test-strategy evidence command `security find-certificate -a -Z -c "Swarm Office
Add-in Local CA"` finds it; removal still goes **by SHA-1 only**.

## 0. Common setup (any shell)

```sh
export PATH=/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin:$PATH
SPIKE=/Users/gsp-budi/Swarm_OnDevice/swarm/packages/office-addin/test/spikes/s1-s2
OUT=$TMPDIR/swarm-office-spike-s1-s2     # keep the same value in every later step
cd $SPIKE
bun gen-certs.ts $OUT                    # prints SHA-1 / SHA-256; also $OUT/fingerprints.json
CA_SHA1=$(bun -e "console.log((await Bun.file('$OUT/fingerprints.json').json()).ca.sha1)")
echo $CA_SHA1                            # record this in SP-S1.md; teardown uses it
openssl x509 -in $OUT/ca.cert.pem -noout -text -ext nameConstraints
```

`SPIKE_NC_CRITICAL=0 bun gen-certs.ts $OUT` makes the nameConstraints extension non-critical
(default critical, per RFC 5280). Use it only if S1 shows macOS rejects a critical one, and record
that as a finding. Regenerating changes every fingerprint: untrust the old CA first (section 4).

## 1. Row 35: SP-S1 (needs sandbox bypass; user present)

Start the server (binds ports; stop with Ctrl-C):

```sh
cd $SPIKE && bun server.ts $OUT
```

Port and address-family evidence (O1, O4):

```sh
sysctl net.inet.ip.portrange.first net.inet.ip.portrange.last net.inet.ip.portrange.hifirst
lsof -nP -iTCP:46317 -sTCP:LISTEN
```

Trust the spike CA in the **login** keychain (register §6.1 trust command; the user approves the
macOS prompt):

```sh
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db $OUT/ca.cert.pem
```

Variant to record (register §6.1 "`-p ssl` added if SP-S1 shows it is accepted"): if the user
agrees, remove (section 4) and re-add with `-p ssl` to scope the trust to SSL only:

```sh
security add-trusted-cert -d -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db $OUT/ca.cert.pem
```

Note: `-d` writes the admin trust-settings domain and may ask for an admin password instead of
the login password. Record which prompt appeared (G2). If the user declines `-d`, the user-domain
form is the same command without `-d`; record which form was used.

Confirm what is installed:

```sh
security find-certificate -a -Z -c "Swarm Office Add-in Local CA" ~/Library/Keychains/login.keychain-db
security dump-trust-settings -d 2>/dev/null | grep -A3 "Swarm Office Add-in Local CA"
security dump-trust-settings    2>/dev/null | grep -A3 "Swarm Office Add-in Local CA"
```

Install the S1 manifest into the Word wef folder (a TCC "access data from other apps" prompt is
possible, G8; Finder copy is the fallback):

```sh
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp $SPIKE/manifest-s1.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/swarm-office-spike.xml
shasum -a 256 $SPIKE/manifest-s1.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/swarm-office-spike.xml
```

User: quit and reopen Word, Home > Add-ins > "Swarm Spike S1". Evidence: screenshot of the pane
showing `host Word`, `platform Mac`; `$OUT/access.log` lines (`family` = IPv4 or IPv6, `host`
header, `pane-report`); where the add-in was listed (OQ-T7).

## 2. Row 35: SP-S1v = ST-10 (after the CA is trusted)

Primary evidence, system trust (no `--cacert`, no `-r`):

```sh
security verify-cert -c $OUT/localhost.cert.pem -p ssl -s localhost   ; echo "exit $?"
security verify-cert -c $OUT/example.cert.pem   -p ssl -s example.com ; echo "exit $?"
```

Pass = `localhost` accepted (exit 0) **and** `example.com` rejected (non-zero). If `example.com`
is accepted, macOS does not enforce the name constraint: SC-22 replaces SC-21 (security RC-3).

Supporting evidence with the server running (`/usr/bin/curl` using system trust is a hypothesis
per ST-10; record its result, but do not decide on it alone):

```sh
/usr/bin/curl -sS --noproxy '*' --resolve localhost:46317:127.0.0.1 https://localhost:46317/pane/index.html -o /dev/null -w "%{http_code}\n"
/usr/bin/curl -sS --noproxy '*' --resolve example.com:46318:127.0.0.1 https://example.com:46318/ ; echo "exit $?"
```

Reference (no keychain involved, already proven by row 32): OpenSSL rejects the example.com leaf
with `permitted subtree violation`:

```sh
openssl verify -CAfile $OUT/ca.cert.pem $OUT/localhost.cert.pem $OUT/example.cert.pem
```

## 3. Row 36: SP-S2 (server still running, CA still trusted)

Replace the S1 manifest in Word and add the same S2 manifest to Excel:

```sh
for app in Word Excel; do
  d=~/Library/Containers/com.microsoft.$app/Data/Documents/wef
  mkdir -p "$d" && cp $SPIKE/manifest-s2.xml "$d/swarm-office-spike.xml" && shasum -a 256 "$d/swarm-office-spike.xml"
done
shasum -a 256 $SPIKE/manifest-s2.xml
```

User: quit and reopen Word and Excel, open "Swarm Spike S2" from Home > Add-ins in each.
Evidence: a screenshot per app (pane plus the 32/64 px icon in the list), `pane-report` lines with
`host Word` and `host Excel`, listing location (OQ-T7).

## 4. Row 39: teardown (by recorded SHA-1 only)

Stop the server (Ctrl-C), then:

```sh
security remove-trusted-cert -d $OUT/ca.cert.pem      # use without -d if it was added without -d
security delete-certificate -Z $CA_SHA1 ~/Library/Keychains/login.keychain-db
rm -f ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/swarm-office-spike.xml
rm -f ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/swarm-office-spike.xml
rm -rf $OUT
```

If `$OUT` is gone but the certificate is still in the keychain, take the SHA-1 from SP-S1.md (or
from `find-certificate -Z` output, checking the CN ends in `(spike)`), export that one certificate
to a file and remove its trust before deleting it:

```sh
security find-certificate -c "Swarm Office Add-in Local CA (spike)" -p ~/Library/Keychains/login.keychain-db > $TMPDIR/spike-ca.pem
openssl x509 -in $TMPDIR/spike-ca.pem -noout -fingerprint -sha1   # must equal the recorded SHA-1
security remove-trusted-cert -d $TMPDIR/spike-ca.pem
security delete-certificate -Z <SHA-1> ~/Library/Keychains/login.keychain-db
```

Done check (row 39 verification), expected empty:

```sh
security find-certificate -a -Z -c "Swarm Office Add-in Local CA" ~/Library/Keychains/login.keychain-db
ls ~/Library/Containers/com.microsoft.Word/Data/Documents/wef ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef
```

The Office add-in cache (`~/Library/Containers/com.Microsoft.OsfWebHost/Data/`) is not touched by
teardown; clearing it is a separate, user-confirmed action (register §6.3).

## 5. Checks run by row 32 (no keychain, no Office)

```sh
cd $SPIKE
/Users/gsp-budi/Swarm_OnDevice/swarm/packages/office-addin/node_modules/.bin/tsgo --noEmit -p tsconfig.json
grep -nE "security|execFile|spawn|Bun\.\$|child_process" gen-certs.ts icons.ts server.ts   # expect no matches
SPIKE_V6=0 bun server.ts $OUT   # smoke; needs port binding (sandbox bypass)
```
