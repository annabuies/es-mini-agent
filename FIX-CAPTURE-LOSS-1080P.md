# Fix: drop the three Source Record filters to 1080p60

**For:** Robbie (and the AI assistant on the studio Mini)
**Time:** about 10 minutes, including the proof test
**Prerequisite:** none. This does not need an `install.sh` re-run and does not need OBS restarted.

---

## 1. What we already proved (do not re-investigate)

The Mini's own test settled it:

| | measured |
|---|---|
| recorded by the clock | 60.0 s |
| local file on the Mini, before any upload | 19.58 s (cam1/cam2), 19.55 s (cam3) |
| frames captured | ~1175 over 60 real seconds = **~19.6 fps**, written at 60 fps |
| OBS "skipped frames due to encoding lag" | **96.9% / 97.1% / 97.5%** |
| OBS render lag over the same window | **0.1%** (3591 of 3594 frames drawn) |

Frames arrive fine and get drawn fine. The encoder throws away about two thirds of them. It is already the Apple VideoToolbox hardware encoder, so there is no encoder to switch to. Three simultaneous native 4K60 encodes exceed what the M4's hardware encoder can do. One fit, three do not.

**The network is innocent.** NDI is delivering at full rate. Do not chase the switch, the cables, or NDI bandwidth mode for this. (cam3's separate freeze fault is a different item, see section 5.)

---

## 2. The fix

Record **1920x1080 at 60 fps** per camera instead of the source's native 3840x2160.

Robbie's reasoning, which we agree with: the only reason for 4K was punch-in flexibility in post while chair positions were uncertain. The preset system solves that better. Booking knows party size, the agent recalls the preset, the cameras frame optically before recording. PTZ framing beats cropping anyway.

Three things get better at once:
- Encoder load drops to roughly a quarter. That is the actual fix.
- The existing 6 Mbps bitrate goes from badly under-spec for 4K60 to appropriate for 1080p60.
- Storage and upload per session drop about 75%.

The OBS canvas is already 1920x1080, so 1080p is what the rest of the system is built around anyway.

---

## 3. Applying it

Both routes are fine. Pick one.

### Route A: OBS UI (Robbie)

For **each** of cam1, cam2, cam3:

1. Right-click the source, **Filters**.
2. Select the **Source Record** filter.
3. Find the resolution / scale control. It is currently recording at the source's native size (3840x2160) because that setting was never changed from its default.
4. Set it so the recording output is **1920x1080**. If the control offers a canvas-matched option rather than a typed size, that is equivalent here, because the canvas is already 1920x1080.
5. Leave **everything else alone**: bitrate, encoder, container, path, filename format, `scale_type`, record mode, audio.

### Route B: obs-websocket (the Mini's AI assistant)

Live, no OBS restart, no UI. The exact property names are plugin-specific, so **discover them first, do not assume them**:

1. `GetSourceFilterDefaultSettings` with `filterKind: "source_record_filter"` to see every available property and its default.
2. `GetSourceFilter` for cam1's `Source Record` to see what is currently saved (we know it is only `path`, `scale_type: 3`, `record_mode: 0`, so every resolution-related key is sitting at default).
3. Identify the resolution/scale keys from step 1, then `SetSourceFilterSettings` on all three cameras with only those keys changed.
4. Re-read all three with `GetSourceFilter` and confirm they now match each other exactly.

Do not write a key you did not see in step 1's output.

---

## 4. The proof test (required, this is what closes the item)

Same test the Mini already ran, so the numbers are directly comparable.

1. Start a recording, confirm all three are writing.
2. Hold **60 seconds by the clock**.
3. Stop.
4. On the **local file on the Mini**, before caring about any upload:

```
for c in cam1 cam2 cam3; do
  f=$(ls -t ~/es-mini-recordings/$c/*.mkv | head -1)
  echo "$c: $(basename "$f")"
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,nb_read_frames,r_frame_rate \
    -show_entries format=duration -count_frames -of default=nw=1 "$f"
done
```

**Pass looks like:**

| | before | required after |
|---|---|---|
| duration | 19.58 s | **~60 s** |
| frames | ~1175 | **~3600** |
| width x height | 3840x2160 | **1920x1080** |

5. Then confirm it in OBS's own log, which is the independent check:

```
grep "skipped frames due to encoding lag" ~/Library/Application\ Support/obs-studio/logs/$(ls -t ~/Library/Application\ Support/obs-studio/logs | head -1)
```

The percentage for this recording should be **near 0%**, down from 97%.

**If it still drops frames at 1080p60**, do not start changing other things. Report the new numbers. The next lever is 60 fps to 30 fps, which halves the load again, and that is a decision for Anna, not a thing to try on the spot.

---

## 5. Do not do these

- **Do not raise the bitrate yet.** The ~60 Mbps ask from the earlier runbook is now on hold. Raising bitrate on an encoder that is already saturated can make the loss worse, and at 1080p the current 6 Mbps is roughly right anyway. Sequence it, do not bundle it.
- **Do not restart OBS.** The known quirk stands: OBS ignores SIGTERM with three 4K NDI receivers and wedges after saving config. Nothing here needs a restart.
- **Do not delete anything from `~/es-mini-recordings/`.**
- **Do not treat cam3's freezes as fixed by this.** cam3 showed contiguous dead freezes (0.42 s and 1.53 s in earlier takes) that cam1 and cam2 did not. That is a second, separate fault in its own NDI path, and dropping to 1080p will not address it. Worth checking its cable and switch port independently, after this fix is confirmed.

---

## 6. Why this was worth the trouble

Every 3-camera recording so far has been keeping about a third of the footage and writing it as if it were 60 fps, so a 60 minute session becomes a ~20 minute file that plays back at roughly 3x speed. That is what "laggy" has been the whole time. It is data loss, not a quality setting, which is why nothing should record for a real client until the proof test above passes.
