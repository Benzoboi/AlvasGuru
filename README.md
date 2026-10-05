# Sleep Watcher (MVP)

A minimal Electron prototype for a sleep/motion/sound watcher that:

- captures the local camera + microphone,
- detects motion (frame-diff on a downscaled frame) and audio level (RMS),
- keeps a rolling pre-buffer using `MediaRecorder` (30s by default),
- saves events (pre-buffer + the event itself) to local disk with metadata,
- exposes a simple local UI for configuration, playback and reports.

Everything stays on the machine: nothing is uploaded anywhere.

## Run locally

```bash
npm install
npm start
```

## How detection works

The recorder runs uninterrupted and emits a 1-second chunk at a time into a
rolling buffer. When motion or sound crosses its threshold:

1. the buffer stops being trimmed, so the pre-roll is not eaten by the wait,
2. the app waits until motion **and** audio have stayed below their thresholds
   for 1.5s (or 60s pass, whichever comes first),
3. the recorder is flushed and the whole buffer - pre-roll plus the event - is
   written to disk as one `.webm` plus a `.json` sidecar.

The first chunk of a recorder session carries the WebM/EBML header. It is kept
aside and prepended to every clip, otherwise clips saved more than one
pre-buffer length after start would not be playable.

After each event a configurable cooldown suppresses re-triggering.

## Two ways to run - pick one

Monitoring starts **either** by hand **or** by the clock, never both at once.
The mode is a radio button in the **Controls** tab.

**Manual** - the Start and Stop buttons decide. The Start/End times are ignored
entirely and greyed out.

**Scheduled** - the app starts capture itself when the clock reaches Start and
stops it at End; the Start and Stop buttons are disabled and inert. Overnight
windows such as `22:00`-`08:00` work, and if you open the app in the middle of
a window it starts right away. Setting Start equal to End means all day.

Switching mode ends whatever session is running, so the new owner always begins
from a clean slate. The status line under the settings always spells out what is
happening now ("Manual mode - press Start to begin", "Scheduled mode -
monitoring, stops automatically at 08:00").

The app window has to stay open in both modes - the camera lives in the window.

## Other settings

| Setting | Meaning |
| --- | --- |
| Motion threshold | Mean per-pixel frame difference (0-255) that counts as motion. |
| Audio threshold | RMS audio level (0-1) that counts as sound. |
| Pre-buffer (s) | How much is kept from *before* the trigger (5-300). |
| Cooldown (s) | Quiet period after an event before the next can fire (0-3600). |
| Keep for (days) | Retention; older files are deleted (1-3650). |

Both thresholds are shown live in the status line - watch them for a minute in
the real room and set each just above its resting level.

The config is stored in `app.getPath('userData')/config.json` and every value is
validated and clamped on load, so a hand-edited file cannot break the app.

## Storage

- Recordings go to `app.getPath('userData')/recordings` as
  `event-<timestamp>.webm` plus a matching `.json` with reason, start/end time
  and duration.
- Files older than the retention setting are removed on startup and once a day;
  **Run cleanup now** triggers it by hand.

## Reports & export

The **Reports** tab lists per-day events with a per-hour bar chart. **Export
CSV** writes `report-<date>.csv` (columns: day, time, reason, file,
durationSec) into the recordings folder.

## Tests

The suites in `.selftest/` boot the real app (real main process, real renderer,
real IPC) and assert against it. They run against an isolated `userData` folder
(`sleep-watcher-selftest`), so your own recordings are never touched.

```bash
npm test            # 49 checks: IPC surface, config clamping, window/mode logic,
                    # motion maths, rolling buffer, path-traversal refusal
npm run test:schedule # 23 checks, ~60s: manual vs scheduled mode - auto-start,
                      # auto-stop, inert buttons, mode switching
npm run test:capture  # 27 checks, ~90s: full pipeline against Chromium's fake
                      # camera - records a real event and verifies the .webm
                      # actually decodes
npm run test:stop     # 14 checks, ~40s: pressing Stop mid-event still writes a
                      # valid, playable file
```

The capture suites use `--use-fake-device-for-media-stream`, so they need no
real webcam and never open a permission prompt.

## Packaging

```bash
npm run dist    # installers
npm run pack    # unpacked directory only
```

## Notes

- The renderer runs sandboxed (`contextIsolation: true`, `nodeIntegration:
  false`); all disk access goes through the IPC surface in `preload.js`.
- Playback reads the file over IPC into a `blob:` URL rather than pointing the
  `<video>` at a `file://` path.
- Next steps: nicer UI, per-event thumbnails, optional notifications.
