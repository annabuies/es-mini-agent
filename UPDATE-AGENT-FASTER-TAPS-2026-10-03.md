# Faster Record/Stop: bench-1 check (2026-10-03)

Agent **2026.10.03-1** makes kiosk taps reach the Mini sooner. Background: Record and Stop took 3-5 s to react.

Nothing to install. The agent self-updates; no plist or installer change.

## What changes on the Mini

- While the room is in use (a take is running, or any kiosk command in the last 2 minutes), the agent asks the Worker for new commands every **0.25 s** instead of every 1 s. When the room is idle it stays at 1 s, so an idle studio makes no more requests than before.
- If the Worker or Supabase is failing, the agent retries after 1 s, then every 2 s, instead of hammering it.
- A take with only RTSP cameras and no master skips a 0.9 s wait at Stop. bench-1 records the master, so its Stop waits for the master file as before.
- Each command's log line now says how long the agent spent on it (`op took N s`).

## 0. Before you start (Anna)

1. Merge the PR, then queue the `update` op for bench-1 while the room is idle.
2. Check the heartbeat shows `agent_version` = `2026.10.03-1`.

## 1. Check the agent picked it up (Robbie, Mini terminal, 1 min)

```
grep "relay: polling" ~/Documents/es-mini-agent/agent.log | tail -1
```

- **Pass:** the line ends `every 250ms while the room is in use, 1000ms when idle`.
- **Fail:** it ends `every 1000ms` (old agent still running). Tell Anna.

## 2. Tap timing (kiosk, about 10 min)

Record five takes of ~20 s each (Start, wait, Stop), 20-30 s apart. For each take, time with a phone stopwatch:

- **Record:** from the tap until the kiosk shows it is recording.
- **Stop:** from the tap until the kiosk shows the take is saved.

Then copy the matching agent log lines:

```
grep -E "relay: claimed (start|stop)|\[take\]|\[rtsp\] cam[0-9] recording" ~/Documents/es-mini-agent/agent.log | tail -40
```

Send Anna the ten times plus those lines. **Pass:** both taps react faster than the 3-5 s from before. The `op took` numbers show how much of each tap is the Mini's own work (camera start, master settle, file check), so whatever is still slow can be fixed next.

## Roll back

`POLL_INTERVAL_MS=1000` in the LaunchAgent plist (then restart the agent) puts the poll back to 1 s in all cases. Ask Anna before editing the plist.
