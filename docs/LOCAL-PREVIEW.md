# Local camera preview for bench-1: runbook

Owner: Anna. One command per step. Nothing here prints or stores a secret.

## What is live today (2026-11-08)

| Piece | State |
| --- | --- |
| Worker (es-os-app `477be4e`, version `266905e7…`) | has all local-preview code; `POST /api/preview-auth` answers 401 because the flag is off |
| Kiosk (TestFlight 1.0 (48)) | has the in-room WHEP client; joins the relay on the next 25 s keepalive once offered, no relaunch |
| Mini agent `2026.11.05-1` (`20230f2`) | has the relay publish + forward code; never calls the relay while the flag is off |
| Flag `LOCAL_PREVIEW_ROOMS` | **unset = off** |
| DNS `preview-bench1.evrybdystudios.com` | **not created yet** (L1) |
| Certificate | **not issued yet** (L1b) |
| Relay on the Mini | **not installed yet** (L2, `scripts/install-preview-relay.sh`) |

## L1. DNS name (Anna's Mac)

DNS only, pointing at the Mini's wired address (en0, manual 172.16.1.35). Zone `evrybdystudios.com` is on the ES Cloudflare account.

```
curl -s -X POST -H "Authorization: Bearer $(cat ~/.cache/cf/es_cloudflare_zone_token)" -H "Content-Type: application/json" "https://api.cloudflare.com/client/v4/zones/fb5d83458a12fdbf740131db5abd672d/dns_records" --data '{"type":"A","name":"preview-bench1","content":"172.16.1.35","ttl":300,"proxied":false,"comment":"ES bench-1 Mac mini preview relay (LAN only)"}' | jq -c '{success,errors,id:.result.id}'
```

Readback (wait a minute):

```
dig +short preview-bench1.evrybdystudios.com @1.1.1.1
```

Expect `172.16.1.35`. If `success:false` with an auth error, the cached zone token can read DNS but not edit it: add the record in the Cloudflare dashboard (ES account → evrybdystudios.com → DNS → Add record: A, `preview-bench1`, `172.16.1.35`, Proxy **off**, TTL 5 min). Rollback: delete the record.

## L1b. Certificate (Anna's Mac, lego 5.6.0 installed by Homebrew)

DNS-01 through Cloudflare. The token stays on Anna's Mac; the Mini only gets the two files.

```
CF_DNS_API_TOKEN="$(cat ~/.cache/cf/es_cloudflare_zone_token)" lego run --accept-tos --dns cloudflare --domains preview-bench1.evrybdystudios.com --path ~/es-preview-certs
```

(lego 5 puts the flags after `run`. If it asks for an email, add `--email <ops address>`.)

Readback:

```
find ~/es-preview-certs -name 'preview-bench1.evrybdystudios.com.*'
```

```
openssl x509 -in "$(find ~/es-preview-certs -name 'preview-bench1.evrybdystudios.com.crt' | head -1)" -noout -subject -issuer -enddate
```

Expect issuer Let's Encrypt and an end date about 90 days out. Put the end date in memory as a dated renewal reminder (renew at 60 days: same command with `renew` handled by `lego run` again).

## L1c. Copy the two files to the Mini (Anna's Mac)

```
ssh -i ~/.ssh/id_ed25519_es_mini megadesk-command@100.75.212.27 'mkdir -p -m 700 ~/es-preview-certs-inbox'
```

```
scp -i ~/.ssh/id_ed25519_es_mini "$(find ~/es-preview-certs -name 'preview-bench1.evrybdystudios.com.crt' | head -1)" "$(find ~/es-preview-certs -name 'preview-bench1.evrybdystudios.com.key' | head -1)" megadesk-command@100.75.212.27:es-preview-certs-inbox/
```

Optional check before Robbie runs it (changes nothing):

```
ssh -i ~/.ssh/id_ed25519_es_mini megadesk-command@100.75.212.27 'cd ~/code/es-mini-agent && git fetch -q origin && git checkout -q --detach 48c7a68a3b7d68d98e36a781eeac475f98a5094c && /bin/bash scripts/install-preview-relay.sh --dry-run'
```

## L2. Relay install (Robbie, in Terminal on the Mini, nothing booked for 30 minutes)

```
cd ~/code/es-mini-agent && git fetch origin && git checkout --detach 48c7a68a3b7d68d98e36a781eeac475f98a5094c && /bin/bash scripts/install-preview-relay.sh
```

It stops with `STOPPED: nothing was changed` on any failed check, and rolls back on a failed readback. Success ends with `===== ES PREVIEW RELAY INSTALL REPORT =====` and `result: SUCCESS`. Robbie pastes the whole block back.

Readback from Anna's Mac afterwards:

```
ssh -i ~/.ssh/id_ed25519_es_mini megadesk-command@100.75.212.27 '/bin/bash ~/code/es-mini-agent/scripts/install-preview-relay.sh --status'
```

With the flag still off, the relay is idle and nothing in sessions changes.

## L3. Switch on (Anna, es-os-app repo, inside a booked-free one-hour window with Robbie)

Note the current Worker version first (a secret put makes a new version with the current code):

```
cf es wrangler deployments list --config worker/wrangler.jsonc
```

```
printf '%s' '{"bench-1":"https://preview-bench1.evrybdystudios.com:8889"}' | cf es wrangler secret put LOCAL_PREVIEW_ROOMS --config worker/wrangler.jsonc
```

The kiosk shows "● Live view · in room" within about 30 s. Phones stay "via cloud" by design.

## L5. Switch off (any time, instant fallback to cloud)

```
cf es wrangler secret delete LOCAL_PREVIEW_ROOMS --config worker/wrangler.jsonc
```

Remove the relay too (optional, Robbie or SSH):

```
/bin/bash ~/code/es-mini-agent/scripts/install-preview-relay.sh --uninstall
```

## Verified before release (2026-11-08, Anna's Mac, sandbox)

- 15 tests in `test/install-preview-relay.test.js` under `/bin/bash` 3.2: install, status, re-run, SHA mismatch, bad host / expiring / wrong key certificate, no certificate, bad tar, rollback on update, clean failure on first install, dry run, uninstall, port in use, no key in output.
- Real MediaMTX v1.21.3 binary through the installer (path with spaces): readback OK; CORS preflight from `capacitor://localhost` → 204 with `access-control-allow-origin: capacitor://localhost` (closes that field-open item); `PATCH /v3/config/paths/patch/bench-1` → 200 (what the agent does); a WHEP POST with no pass → the live Worker answers 401 and the relay refuses.

## Known limits (from the build plan, unchanged)

1. Master MKV likely shows the preview overlay (L6 readback decides).
2. Relay → Cloudflare forward is unproven in the field; if it fails, phones lose the cloud picture while the kiosk is fine. Rollback = flag off.
3. Internet down = no preview at all (every relay read/publish asks the Worker).
4. Saved publish pass expires after 10 min; a stream restore after that can silently fall back to cloud.
5. No heartbeat field for the route; evidence = agent log `route=local` and the kiosk diagnostics panel.
6. Relay runs only while `megadesk-command` is logged in.
7. Certificate renewal is manual (~90 days). `--status` prints the expiry.
8. Two active interfaces on the Mini; DNS points at en0. Turning Mini Wi-Fi off fixes odd ICE pairing.
9. Still field-open: Cloudflare accepting the forwarded WHIP, ICE across the iPad's mDNS candidates, router DNS-rebinding protection on a public name → 172.16.x. Each fails safe to cloud.
10. macOS 15 Local Network privacy may show an "allow to find devices on local networks" prompt for `mediamtx` the first time a viewer connects. Click Allow on the Mini's screen.
