# New property: from "signed" to "first take" (repo side)

The full SOP lives in the wiki: **`Clients/ES/SOP-NEW-PROPERTY-ONBOARDING-2026-11-06.md`** (ab-wiki; written on branch `claude/es-mini-one-command-20261106-wiki`). It has an owner, an input, the exact command or form, and a check for each of 7 steps. This page lists what the Mini repo provides for each step.

| Step | Owner | What the repo gives you |
|---|---|---|
| 1. Decide (`building_id`, Mini owner, login policy, support path) | Anna + Robbie + the partner | `building_id` rule: lowercase, digits, dashes, never reused (`fsu-1`). It is the S3 prefix `recordings/<building_id>/…` (`upload-queue.js:546`) and the heartbeat row key. Login policy: the installer reports FileVault and `pmset autorestart`, never changes them (`install.sh` preflight). |
| 2. Network | the partner's IT | Outbound HTTPS needed by the agent: `RECORD_POLL_URL` (`https://api.evrybdystudios.com`), the storage host, the upload webhook host. The installer also downloads from GitHub releases; with no GitHub access, use the local-tar path in [INSTALL.md](INSTALL.md). |
| 3. Cloud row | Anna | The agent reads its room config from `studios.fleet_buildings` through the Worker (`obs_sources`, `cameras`, `looks`, `default_look`, `upload_webhook_url`). It authenticates with the one shared `RECORD_CONTROL_KEY`. The SOP has the insert template. |
| 4. Hardware bench | Robbie | [../SETUP-MAC-MINI.md](../SETUP-MAC-MINI.md) steps 2–5 (OBS, Source Record, obs-websocket, scenes). |
| 5. Mini prep + **one command** | Robbie, in Terminal on the Mini | [INSTALL.md](INSTALL.md) "Fresh Mini": `ES_MINI_CONFIG` file (mode 600) + the pinned release line Anna sends, with `--obs-launcher`. |
| 6. Acceptance | Robbie, Anna approves | The installer's report covers readbacks R1–R3 and R7. The rest (heartbeat, mic routes, cameras, takes A1–A8, lights refusal, headless) is on the S6 forms. |
| 7. Hand to operations | Anna | The report block gives the backup folder, the runtime folder and version, and the env key names (never values). |

Updates after go-live: [INSTALL.md](INSTALL.md) "For Robbie" (3 steps). Never the `update` op, never `main`.
