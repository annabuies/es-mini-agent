# RTSP camera capture: bench-1 test (2026-09-29, evening ET)

Agent **2026.09.29-2** records a camera straight from its RTSP stream with ffmpeg (stream copy) when its camera entry says `"capture": "rtsp"`. OBS Source Record is out of the path for that camera. OBS still records the master and mic tracks and drives the live preview. Background: issue #10.

Nothing to install. The agent self-updates, and the camera switch is a database change on Anna's side.

## 0. Before you start (Anna)

1. Merge the PR, then queue the `update` op for bench-1 while the room is idle.
2. Check the heartbeat shows `agent_version` = `2026.09.29-2`.
3. Switch the cameras (see "Switch" below). The Mini picks it up within 60 s.

## 1. Check the RTSP path (Robbie, Mini terminal, 2 min)

Use the same URL you used in the Sep 24 test. The agent assumes `rtsp://<camera-ip>:554/1` for all three.

```
ffmpeg -version | head -1
ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name,width,height,avg_frame_rate -of compact "rtsp://<cam1-ip>:554/1"
```

- **Pass:** `h264`, 3840×2160, 30 fps, plus an audio line if camera audio is on.
- **If your Sep 24 test used a different path** (for example `/2`, a different port, or a login), tell Anna before testing. She sets `rtsp_path` or `rtsp_port` per camera. Don't send a camera password in Slack.

## 2. Test takes (kiosk, about 15 min)

Record these on the kiosk, the way you did this morning:

| # | Take | What to do |
|---|---|---|
| 1–5 | ~30 s each | Start, wait, Stop. Leave 20–30 s between takes. |
| 6 | ~45 s | Start, Pause ~5 s, Resume, Stop. |
| 7 | ~3 s | Start, then Stop right away (this morning's take 2 case). |

For each take, check:

- **Files:** `cam1`, `cam2` and `cam3` are each MB-sized (roughly 4 MB per second of recording each), with the **same file name as the master**.
- **Probe:**
  ```
  ffprobe -v error -show_entries stream=codec_type,codec_name,width,height:format=duration -of compact "<file>"
  ```
  Expect one `h264` video stream (not `hevc` as before) and **no audio stream** (the cameras' empty AAC track is left out on purpose). The duration should be within about 1 s of the master, and there should be one file per camera, not parts.
- **Agent log:** each camera has one line of the form `[rtsp] camN saved <name>.mp4 bytes=… segments=1 reconnects=0`. Take 6 shows `segments=2`.
- **Log problems:** any `falling back to Source Record`, `ffmpeg exited mid-take` or `concat failed` line is a finding. Paste it into issue #10 (IPs redacted).
- **Slack:** the session thread lists all three cameras plus the master, and no "recording failed".
- **CPU:** Activity Monitor during a take, three `ffmpeg` processes plus OBS. Sep 24 was about 13%.

## Switch (Anna, prod SQL)

All three cameras to RTSP:

```sql
update studios.fleet_buildings
set cameras = (select jsonb_agg(c || '{"capture":"rtsp"}') from jsonb_array_elements(cameras) c)
where building_id = 'bench-1';
```

Only cam1:

```sql
update studios.fleet_buildings
set cameras = (select jsonb_agg(case when c->>'name' = 'cam1' then c || '{"capture":"rtsp"}' else c end) from jsonb_array_elements(cameras) c)
where building_id = 'bench-1';
```

**Rollback** (back to Source Record from the next take, within 60 s, no Mini visit):

```sql
update studios.fleet_buildings
set cameras = (select jsonb_agg(c - 'capture') from jsonb_array_elements(cameras) c)
where building_id = 'bench-1';
```

## Know before you look

- **Bigger files.** Three cameras at 32 Mbps are about 43 GB per recorded hour, versus about 24 GB/h before. Watch free disk in the heartbeat and upload time.
- **cam2/cam3 resolution.** They are now whatever the camera streams. If that's 4K, they're bigger than the old 2560×1440 Source Record files.
- **Start latency.** Each RTSP camera normally connects in about 1 s at Start (4 s at most). If one doesn't connect, that camera falls back to Source Record for that take, so a take is never missing a camera because of RTSP.
- **Unchanged:** the master, the mic split, the preview and the kiosk.
