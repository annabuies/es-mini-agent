# es-mini-agent

**This agent proves the app-to-Mini connection is real. It does NOT control real cameras / audio / OBS yet — that is a separate future build once the physical rig exists.**

Small zero-dependency Node HTTP service that runs on a FLEET Mac Mini (or a bench-test Mac standing in for one). The Vercel proxy at `es-os-app/api/record.js` forwards `/record/{start|stop|status|pause|resume}` calls here once `RECORD_CONTROL_URL` and `RECORD_CONTROL_KEY` are set on Vercel. Until then, the proxy returns honest mocks; this agent is what flips it from mock to real.

## Requirements

- Node.js `>=18` (uses only the built-in `http` module — zero runtime deps).

## Install

Nothing to install. `npm install` is a no-op (no dependencies).

## Configure

Three env vars:

| var                  | required | example                       | notes |
|----------------------|----------|-------------------------------|-------|
| `PORT`               | no       | `8787`                        | default `8787` |
| `RECORD_CONTROL_KEY` | **yes**  | long random string            | must match the value set on Vercel; agent refuses to start if unset |
| `BUILDING_ID`        | **yes**  | `bench-1`                     | this Mini's identity; one Mini serves exactly one building |

Copy `.env.example` for local dev, or edit the `EnvironmentVariables` dict in `com.es.mini-agent.plist` for launchd.

## Run locally (quick bench test)

```bash
RECORD_CONTROL_KEY=devsecret BUILDING_ID=bench-1 node server.js
```

### curl examples

Health (no auth):

```bash
curl -s http://localhost:8787/health | jq
```

Start / status / pause / resume / stop (all require the bearer token):

```bash
KEY=devsecret
BID=bench-1

curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/status \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/pause \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/resume \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"

curl -s -X POST http://localhost:8787/record/stop \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"building_id\":\"$BID\",\"client_code\":\"abc123\"}"
```

Unauthorized should look like:

```bash
curl -s -X POST http://localhost:8787/record/start -d '{}'
# -> {"ok":false,"reason":"unauthorized"}
```

Wrong building should look like:

```bash
curl -s -X POST http://localhost:8787/record/start \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"building_id":"some-other-building"}'
# -> {"ok":false,"reason":"building_mismatch"}
```

## Contract (what the Vercel proxy expects back)

- `start`, `status`, `resume` → `{ ok, recording, feeds_writing }` (`feeds_writing` is always `null` until the real rig is wired — the frontend gracefully renders "3" when null; do not invent fake counts here.)
- `stop` → `{ ok, saved }`
- `pause` → `{ ok, paused }`

Request body from the proxy: `{ building_id, client_code }`. Auth: `Authorization: Bearer <RECORD_CONTROL_KEY>`.

## Install as a launchd LaunchAgent (auto-start + auto-restart)

1. Edit `com.es.mini-agent.plist`:
   - Replace `REPLACE_ME_WITH_REAL_SECRET` with the same secret you set on Vercel.
   - Replace `REPLACE_ME_e_g_bench-1` with this Mini's `BUILDING_ID`.
   - Confirm the `ProgramArguments` node path matches `which node` on this Mac. On Apple Silicon w/ Homebrew it is typically `/opt/homebrew/opt/node@24/bin/node`.

2. Install and load:

   ```bash
   cp com.es.mini-agent.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

3. Tail logs:

   ```bash
   tail -f ~/Documents/es-mini-agent/agent.log \
           ~/Documents/es-mini-agent/agent.error.log
   ```

4. Reload after edits:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   launchctl load   ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

5. Stop for good:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.es.mini-agent.plist
   ```

`KeepAlive: true` means launchd restarts the process if it crashes — the "self-recovery agent" behavior the FLEET docs describe. `RunAtLoad: true` starts it immediately on load / on user login.

## What this agent explicitly does NOT do (yet)

- No OBS / camera / audio device control.
- No file writing of media.
- No real `feeds_writing` count — always `null`.
- No persistence — state (`recording`, `paused`) is in-memory only and resets on restart. That is intentional for the bench-test phase.

Those come in a follow-up track once the physical studio rig exists.
