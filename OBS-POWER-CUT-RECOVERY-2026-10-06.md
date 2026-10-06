# OBS power-cut recovery — Mini acceptance checklist

The 2026-10-05 test showed macOS reopened OBS before the launcher, despite the installer clearing `TALAppsToRelaunchAtLogin`. OBS waited at its Safe Mode dialog. This revision allows one guarded recovery for that case. Local tests cannot prove macOS launch order or OBS behavior on the Mini.

## Install (after this branch is merged to main)

1. Pick an idle room window; confirm OBS is not recording. Run `bash <(curl -fsSL https://raw.githubusercontent.com/annabuies/es-mini-agent/main/install.sh) --obs-launcher` on the Mini. Confirm the installer reports `launchd loaded com.es.obs-launcher`.
2. Check **System Settings → General → Login Items** and remove OBS if present. The installer does not manage Login Items. Confirm `~/Library/Application Support/es-mini-agent/obs-launcher.sh` contains `recover_reopened_dialog`.
3. Save a copy of `~/Library/Application Support/es-mini-agent/obs-launcher.log` and `obs-launcher.error.log` before testing. Do not send credentials or full environment files.

## Tests, in order

1. **Power cut while OBS is open and idle.** Restore power and log in. Within two minutes, confirm OBS has no Safe Mode dialog and its websocket is listening. If macOS reopens OBS first, the launcher log should say `dialog-blocked OBS exited and its markers were archived; starting a fresh OBS`. If the launcher starts first, it should say it archived the preboot marker and started OBS. Either path should open only one recording-ready OBS.
2. **Normal restart.** Quit OBS cleanly, restart, and confirm one recording-ready OBS with no dialog.
3. **Manual OBS after login.** With the room idle, open OBS by hand before reloading the launcher with `launchctl kickstart -k gui/$(id -u)/com.es.obs-launcher`. Confirm the launcher leaves that process running. If a test recording has started, it must continue uninterrupted.
4. **Crash during the current boot.** Stop any recording first. Run `pkill -SEGV -x OBS`, then `launchctl kickstart -k gui/$(id -u)/com.es.obs-launcher`. Confirm the launcher leaves this boot's marker and raises an `ALERT:` at the Safe Mode dialog. Choose **Run in Normal Mode** to restore the room.

Stop testing if OBS does not exit after the guarded TERM or if recording is interrupted. Restore the room by choosing **Run in Normal Mode** if the dialog is present. Send the launcher logs, the newest OBS startup log, and the observed result of each step to Anna. The log files may contain local network addresses, so share them in the existing private channel.
