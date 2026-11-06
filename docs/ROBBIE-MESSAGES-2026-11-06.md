# Robbie message drafts (2026-11-06)

Drafted by Claude for Anna. **Never sent by Claude.** Anna sends them.
No secrets, no client names, no em dashes.

Facts behind Draft 1 were read over SSH (read-only) and from `studios.fleet_buildings` at 2026-11-06 08:15–08:20 UTC.

---

## Draft 1: send now

Hi Robbie, good news first. I checked the Mac mini this morning and it is healthy.

- Agent 2026.10.20-1, running for 10+ days without a restart
- Heartbeat is fresh, so the app sees it
- 110 GB free
- OBS 32.1.0 with both plugins
- Auto restart after a power cut is on

Nothing you need to fix today.

The update is being packaged as one command.
It makes its own backup first, checks every file, and can roll back with one line.

I will send you the exact text to paste.
Please run it when nothing is booked for about 30 minutes.
Run it in Terminal on the Mac mini itself, not from another computer.

---

## Draft 2: send with the release

Anna fills the three values in the line from the release (see `docs/INSTALL.md` "For Anna"). For 2026.11.05-1 two are already known:

- `ES_MINI_COMMIT=20230f20fdd3345451e947e907b26455daed787b`;
- `ES_MINI_TAR_SHA256=a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802`.

`<INSTALLER_SHA256>` is `shasum -a 256 install.sh` of the file uploaded to the release. Send the line in a code block so nothing gets reformatted.

> Hi Robbie, here is the Mac mini update.
>
> Please do it when nothing is booked for the next 30 minutes.
> Use Terminal on the Mac mini itself.
>
> 1. Paste this one line into Terminal and press Return:
>
> ```
> cd ~/Downloads && curl -fsSLO https://github.com/annabuies/es-mini-agent/releases/download/v2026.11.05-1/install.sh && echo "<INSTALLER_SHA256>  install.sh" | shasum -a 256 -c && ES_MINI_VERSION=2026.11.05-1 ES_MINI_COMMIT=20230f20fdd3345451e947e907b26455daed787b ES_MINI_TAR_SHA256=a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802 /bin/bash install.sh
> ```
>
> If the Mac asks to let Terminal access your Documents folder, click Allow.
>
> 2. It checks everything first and shows a short plan. Type yes and press Return.
> Wait about a minute. It is done when you see:
> SUCCESS: agent 2026.11.05-1 is running from ...
>
> 3. Copy everything from ===== ES MINI INSTALL REPORT ===== down to the last ===== line and send it to me here.
> It has no passwords in it.
>
> If it says STOPPED, nothing changed. The line above it says why, for example the room is recording. Just run the same line again later.
> If it says FAILURE, ROLLED BACK, the Mini is back on the old version and still works. Send me the whole window.
>
> If anything feels off after the update, you can go back with one line.
> It is in your report, next to "rollback:". Paste it in Terminal when nothing is recording.
> It ends with ROLLED BACK.
>
> Thanks!

Checks before sending:

- [ ] round-1 audit GO;
- [ ] release `v2026.11.05-1` published (B3);
- [ ] `<INSTALLER_SHA256>` filled from the uploaded asset;
- [ ] the line tested with `--dry-run` on Anna's bench (or via `--local --dry-run`);
- [ ] Robbie's Mini is still on `2026.10.20-1` (`sb os` heartbeat).
