# Update: `fetch_docs` op (2026.08.18-1)

Adds a read-only operator op that returns the newest `.md`/`.txt` files from the
Mini's `~/Downloads` through the record-command queue — built so Claude Code
incident write-ups left on the Mini (first case: the 2026-08-18 camera/DHCP
outage report) are readable remotely. The Mini is outbound-only; before this,
those files needed a human at the keyboard.

## Bounds

- Max 5 files, newest first; 60KB per file, 150KB total; listing capped at 30.
- `.md`/`.txt` only, no dotfiles, symlinks skipped (lstat, never followed).
- No input: the queue has no args column and the poll path passes `{}` — the op
  only reads basenames its own `readdir` of `~/Downloads` returned.
- Read-only: no OBS, recording, upload, or agent state touched.

## Ship sequence (same as every operator op — see 0059's notes)

1. Apply migration `0067_record_commands_fetch_docs_op.sql` (adds `fetch_docs`
   to the `record_commands` op CHECK).
2. Repo public → `insert into studios.record_commands (building_id, op) values
   ('bench-1','update')` → wait for `done`, confirm `result.version` says
   `2026.08.18-1` → repo private.
3. `insert ... values ('bench-1','fetch_docs')` → read `result.docs` from the
   completed row.

Deliberately NOT in the relay's app-path allowlist: operator tool, not an app
button.
