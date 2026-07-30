# Investigate: 3-camera recordings are keeping only ~34% of the footage

**For:** Robbie (and whoever/whatever is helping him look at the studio Mac)
**From:** Anna's side, 2026-07-30
**Status:** Root cause NOT yet identified. This document is a briefing, not a fix.

> **Read this first if you are an AI assistant helping Robbie.** You have no prior context on this
> system. Everything you need is in this document. Please do not guess at causes — the section
> "What we have already ruled out" exists so you don't repeat work, and "The one test that could
> prove us wrong" exists because we would rather be corrected than confirmed.
>
> **This machine is production studio hardware.** Read "Do not do these things" before running anything.

---

## 1. The problem in one paragraph

When all three cameras record at once, each resulting file contains only about a third of the time
that was actually recorded. The frames that *are* captured are written with 60 fps timestamps, so
the footage is **time-compressed**: it plays back roughly 3x too fast with jumpy motion. A one-hour
session would come back as a ~20-minute file. This was reported for weeks as "the video looks
laggy" — it is not a playback or codec problem, the missing time is baked into the file.

With **one** camera this did not happen. That is the strongest clue we have.

---

## 2. The measurement (so you can trust it, or break it)

Two controlled recordings were driven remotely, with all three cameras confirmed actively writing
throughout:

| Test | Recording held for | File that landed | Kept |
|---|---|---|---|
| A | ~35 s | 12.1 s | **~34%** |
| B | **61.7 s** (precisely timed) | **21.05 / 21.05 / 20.99 s** | **34%** |

**Why this is conclusive rather than a fluke:** the two tests were *different lengths* and returned
the *same fraction*. That rules out a fixed-length file split, a truncated upload, and a late start —
all of which would produce a constant duration, not a constant ratio.

**Derived numbers:**
- Real capture rate: **~20.5 fps per camera** (1263 frames over 61.7 s), written as 60 fps.
- 3 cameras x 20.5 fps = **~61.5 fps total** — i.e. almost exactly **one camera's worth of 60 fps,
  divided three ways.** This is why the "1/N" theory is our leading hypothesis.

**A known-good control, for comparison.** A single-camera recording from 22 July (before the 2nd and
3rd cameras were added), which everyone agrees plays fine:
- 1280 frames, 21.38 s, **59.86 fps**, **0** duplicate frames, **0** stalls. Correctly timed and clean.

**Separately: cam3 has a second, independent fault.** Using exact per-frame hashing (byte-identical
consecutive frames — a measure that does not care what is in the picture), cam3's duplicates arrive
in one **contiguous run**, meaning the picture genuinely froze:

| File | Duplicate frames | Longest single freeze |
|---|---|---|
| 22 Jul control (1 camera) | 0 | none |
| 29 Jul 13-15-22 cam1 | 13 | 0.07 s |
| 29 Jul 13-15-22 **cam3** | 25 | **0.42 s** |
| 29 Jul 13-36-20 cam1 | 0 | none |
| 29 Jul 13-36-20 cam2 | 0 | none |
| 29 Jul 13-36-20 **cam3** | 92 | **1.53 s** |

cam1 and cam2 were completely clean in test B while cam3 froze for a second and a half. **Fixing the
shared 34% problem will not fix cam3.** Treat it as a separate investigation (cable, switch port,
network path, NDI source health).

---

## 3. How the system is actually put together

Worth being precise, because it rules out whole categories of cause:

- **One** Mac mini, running **one** OBS instance, with **one** small Node.js control agent
  (`es-mini-agent`) as a background service under launchd.
- The three cameras are **NDI network sources** arriving over the studio LAN into that one OBS.
- **Recording is done entirely by OBS**, not by the agent. Each camera has its own **Source Record
  filter** writing to its own folder under `~/es-mini-recordings/cam1|cam2|cam3`.
- **The agent does not record, encode, or touch video frames.** It polls a cloud endpoint for
  start/stop commands, toggles those OBS filters via obs-websocket, and uploads finished files.
  It contains no `child_process`/`exec` usage and never shells out.

**So: if frames are being lost, they are being lost inside OBS or upstream of it (NDI/network).
The Node agent is not a plausible cause of missing frames.** Please don't spend time in it.

Current Source Record filter config, read remotely from all three cameras (identical on each):

```
path        = /Users/megadesk-command/es-mini-recordings/cam{1,2,3}
codec_type  = 1635148593   ("avc1" = H.264)
record_mode = 0
scale_type  = 3
```

Note there is **no resolution, frame-rate, bitrate, or encoder field returned** — meaning those are
at defaults. The filter dialog in the OBS UI exposes more than the API returns, so **please read the
actual dialog**, that is where the useful settings are.

Measured output on every file: **3840x2160 @ 60 fps, H.264, ~5.85 Mbps.**

---

## 4. What we have already ruled out

Please don't redo these:

- ❌ **Not the upload/network to the cloud.** Files upload fully and are confirmed; the byte count
  matches the (short) duration.
- ❌ **Not streaming or browser playback.** Anna **downloads the file and plays it locally, and it
  still looks wrong.** This is important: it eliminates the entire delivery path (cloud storage,
  content-type headers, browser codec support, connection speed) as an explanation. Whatever is
  wrong is inside the file itself, which is exactly what the frame measurements show.
- ❌ **Not a truncated or corrupted file.** The files are internally clean: even 60 fps pacing, no
  timeline gaps. They are short, not damaged.
- ❌ **Not OBS's main render thread falling over.** Measured live *during* a 3-camera recording:
  `activeFps` **60.00**, `renderSkippedFrames` **42 out of 4.7 million** (0.0009%), and **zero**
  new skipped frames versus idle. OBS's canvas render is keeping up.
- ❌ **Not disk space.** ~123 GB free.
- ⚠️ **`outputSkippedFrames` / `outputTotalFrames` report `0 / 0` even while recording** — Source
  Record filters are *separate outputs* and are not counted in OBS's main output stats. **Do not
  read `0/0` as evidence that per-camera encoding is healthy. It carries no information here.**

One number that *is* interesting: OBS's `averageFrameRenderTime` goes from **0.870 ms at idle** to
**14.84 ms while recording 3 cameras**, against a **16.67 ms** budget at 60 fps. So the render
thread is at **~89% of budget** — coping, but with very little headroom.

---

## 5. The one test that could prove us wrong — please run this first

Everything above was measured on files **after** they were uploaded. The one thing we could not
check from outside is the file **on the mini itself, before upload**.

**On the studio Mac, immediately after a test recording:**

```bash
ls -lt ~/es-mini-recordings/cam1/ | head -3

# duration + frame count of the most recent local file
f=$(ls -t ~/es-mini-recordings/cam1/*.mkv | head -1)
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 "$f"
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames \
        -of default=noprint_wrappers=1 "$f"
```

Record for a known length (say 60 seconds by the clock) and compare:

- **Local file is also ~20 s** → the loss happens at **capture/encode inside OBS**. Our conclusion
  holds, continue to section 6.
- **Local file is ~60 s** → the loss is in **our upload path**, our diagnosis is wrong, and that is
  our bug to fix, not yours. **Please tell us immediately** — this would overturn the whole finding.

---

## 6. The investigation, in order (cheapest and most decisive first)

### 6.1 The ten-second question that splits the problem in half

**With nothing recording, does each camera look smooth in OBS's own preview / Multiview?**

- **Smooth when idle, but footage is lossy when recording** → the **encoder** is the bottleneck.
  Go to 6.2.
- **Stuttery even when idle, before any recording starts** → **NDI delivery / the network** is the
  bottleneck. Go to 6.3.

This single observation is worth more than any further measurement from our side.

### 6.2 If it points at the encoder

- **Which encoder are the Source Record filters using?** If they are on a **software (x264)**
  encoder, three simultaneous 4K60 software encodes will not keep up on a Mac mini. Apple's
  hardware encoder (VideoToolbox) is dramatically cheaper — though three 4K60 streams may still
  exceed even that.
- **Can each camera record at 1080p instead of 4K?** This roughly quarters the encode cost and is
  our best guess at the practical fix. It would also solve two other known problems at once (see
  section 8).
- **Or 30 fps instead of 60?** Roughly halves it.
- **Check OBS's own log** for encoder-overload messages, which name the problem directly:
  ```bash
  ls -t ~/Library/"Application Support"/obs-studio/logs/ | head -3
  grep -iE "skipped|lagged|overload|encod|drop" \
    ~/Library/"Application Support"/obs-studio/logs/$(ls -t ~/Library/"Application Support"/obs-studio/logs/ | head -1)
  ```

### 6.3 If it points at NDI / the network

- **Full NDI at 4K60 is roughly 250 Mbps per camera.** Three cameras is ~750 Mbps, which will
  saturate a 1 Gb link once overhead is counted. Worth confirming: are the cameras sending **full
  NDI** or **NDI|HX** (compressed, far lower bandwidth)?
- What is the switch, and are all three cameras and the mini on gigabit ports on the same switch?
- Does NDI Studio Monitor (or the OBS source properties) report the **actual received frame rate**
  per camera? ~60 with one camera and ~20 with three would confirm this branch outright.

### 6.4 cam3, separately

cam3 froze for 0.42 s and 1.53 s in two different recordings while the other cameras were clean.
That is not the shared cap. Check its cable, its switch port, and whether it behaves differently
if swapped to another port or another camera's known-good path.

---

## 7. Do not do these things

- ⛔ **Do not raise the Source Record bitrate yet.** There is a pending request to take it from
  ~6 Mbps to ~60 Mbps. **Raising bitrate on an already-saturated encoder could make the footage
  loss worse.** It needs to happen *after* this is understood, not alongside it.
- ⛔ **Avoid restarting OBS unless you actually need to.** There is a documented quirk on this
  machine: with three 4K NDI receivers, OBS ignores SIGTERM on exit and wedges after saving its
  config, requiring a force-kill. Nothing in this investigation requires an OBS restart.
- ⛔ **Do not change the camera list or any agent configuration.** Anna drives that remotely; a
  local change will be silently overwritten within 60 seconds.
- ⛔ **Do not delete anything from `~/es-mini-recordings/`.** Those local files are the evidence for
  section 5.

---

## 8. Useful context: two other things are wrong, but they are ours, not yours

Mentioned only so you don't chase them or get confused if you notice them:

1. **The 1080p "proxy" copies are never being generated.** That is a bug in our agent (it calls
   `ffmpeg` by name, but launchd gives background services a minimal `PATH` that excludes
   Homebrew, so it fails silently). **We are fixing this.** It is unrelated to the footage loss.
2. **Bitrate is ~5.85 Mbps at 4K60**, which is roughly ten times lower than appropriate for that
   resolution and frame rate. Real but chronic, constant across every recording and every date, so
   it is **not** the cause of the 34% loss. Note that **recording at 1080p (section 6.2) would make
   this bitrate reasonable rather than terrible**, which is part of why that option is attractive.

---

## 9. What would be most useful to send back

1. The **local file duration** from section 5 versus the length you actually recorded. (Most important.)
2. The answer to the section 6.1 question: **smooth in preview when idle, yes or no.**
3. The Source Record filter dialog contents for one camera — encoder, resolution, frame rate, bitrate.
4. Anything from the OBS log that mentions skipped, lagged, overloaded, or dropped.
5. Whether the cameras are full NDI or NDI|HX, and what switch they are on.

Anna can run a remote diagnostic on demand that returns OBS stats and the filter config, so if it is
easier to have her pull something rather than dig for it, just ask.

**Please do not apply a fix yet.** We would rather have the diagnosis confirmed first — this has
already been misdiagnosed twice from our end, and a change made now would make the next measurement
uninterpretable.
