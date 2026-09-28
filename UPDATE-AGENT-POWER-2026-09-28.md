# Mini update: automatic lights, OBS launcher, Pro 10 health

**For:** Robbie, on the bench Mac Mini · **From:** Anna · **Takes:** about 10 minutes, plus one restart
**When:** only after Anna says the update is merged, and never during a session.

What this update does:

- The studio lights (Pro 10 outlet 4) come on 15 minutes before a session booked in the OS app, and go off 10 minutes after it ends. They never go off while a take is recording or uploading. Only outlet 4 can ever be switched by software; the router, PoE switch and Mini are blocked in code.
- OBS starts at login through the launcher, with the shutdown check off, so the Safe Mode dialog stops appearing after restarts.
- The Mini checks the Pro 10 every 5 minutes (read-only). If the Pro 10 stops answering for about 10 minutes, #os gets a message.
- The four stuck Sep 7 upload entries are cleared by themselves. They were empty files, so there was nothing to upload.

## Step 1: check the Pro 10 login works (read-only)

In Terminal on the Mini:

```bash
read -rs -p "Pro 10 admin password: " POWER_STRIP_PASS; echo
curl -s --digest -u "admin:$POWER_STRIP_PASS" 'http://172.16.1.40/restapi/relay/outlets/all;/physical_state/'; echo
```

You should see a list of eight `true`/`false` values, for example `[true,true,true,true,false,false,false,false]`. If you see `401`, an HTML page, or nothing at all, stop here and send Anna the output.

## Step 2: re-run the installer

Use the **same Terminal window** so the password from Step 1 is still set. The installer now keeps everything already on this Mac (camera list, OBS password, upload keys, webhook, camera login). You only add the three Pro 10 values:

```bash
POWER_STRIP_URL=http://172.16.1.40 \
POWER_STRIP_USER=admin \
POWER_STRIP_PASS="$POWER_STRIP_PASS" \
bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh) --obs-launcher
```

Check two things in the output:

- A line starting `[ok] Reusing N value(s) from the existing install:` that lists `BUILDING_ID RECORD_CONTROL_KEY OBS_SOURCES ...`. If `OBS_SOURCES` is missing from that list, stop and tell Anna.
- The green **SUCCESS** banner at the end. If you get a red FAILURE banner, run `tail -n 50 ~/Documents/es-mini-agent/agent.error.log` and send that to Anna.

## Step 3: take OBS out of Login Items

System Settings → General → Login Items → select **OBS** → click **−**.

This matters. The launcher does nothing if OBS is already open, so if OBS still starts from Login Items, the Safe Mode dialog comes back.

## Step 4: test the lights from the Mini

Nobody should be recording. In the same Terminal:

```bash
KEY="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:RECORD_CONTROL_KEY' ~/Library/LaunchAgents/com.es.mini-agent.plist)"
power() { curl -s -X POST http://localhost:8787/record/power -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$1"; echo; }
power '{"action":"status"}'
power '{"action":"off","outlets":["lights"]}'
power '{"action":"on","outlets":["lights"]}'
power '{"action":"off","outlets":["mini"]}'
```

What you should see:

1. `status`: `"ok":true` and `"lights":{"outlet":4,"on":true,...}`.
2. `off`: all five Amarans go dark, with `"result":"ok","on":false`.
3. `on`: they come back at their previous settings, with `"on":true`.
4. `mini`: `"reason":"outlet_denied"`, and **nothing** switches off. This proves the Mini can't turn itself off.

## Step 5: restart once

Restart the Mini (Apple menu → Restart). After login:

- OBS opens by itself **without** the Safe Mode dialog.
- All three NDI feeds are back in OBS.

## Step 6: AutoPing on the Pro 10 (web page, not the Mini)

Open the Pro 10 web page (http://172.16.1.40) → AutoPing. Settings below are chosen so that one flaky device can't restart the room in the middle of a session:

| Outlet | Ping target | Settings | Why |
|---|---|---|---|
| 1 Router | `1.1.1.1` | every 60 s, restart after **10** misses in a row, wait at least 30 min between restarts if the page allows | ~10 min of no internet before it acts. Each restart drops the internet (and Anna's remote access) for about 2 minutes. |
| 2 PoE switch | the PoE switch's own IP if it has one; otherwise the camera you trust most | every 60 s, restart after **15** misses in a row | Restarting the PoE switch restarts all three cameras. One camera being unplugged or rebooting must not do that, hence the long threshold. |
| 3 Mac Mini | **none, never** | — | Cutting the Mini's power mid-take loses the recording. |
| 4 Lights | **none** | — | Lights are switched by the automation. |

Take a screenshot of each AutoPing entry and send them to Anna.

## Step 7: report to Anna

Send: **"Mini updated: install SUCCESS, OBS out of Login Items, lights test OK (mini refused), restart clean with no Safe Mode, AutoPing set (screenshots)."**

Anna then checks remotely that the Mini reports agent `2026.09.28-3` and a healthy Pro 10, and turns the automatic lights on (dry run first).

## If something goes wrong

- Lights didn't react in Step 4 but `status` worked: send Anna the output of the `off` line. The switch may need the user's outlet access enabled on the Pro 10's External APIs page.
- Anything else: `tail -n 50 ~/Documents/es-mini-agent/agent.log` and send it to Anna.
- To switch the lights by hand at any time, use the Pro 10 web page. The automation won't fight a manual change during a session.
