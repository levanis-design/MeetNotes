# MeetNotes v1.2.0

Personal Windows desktop app that tracks a meeting, transcribes it locally, keeps your notes, and generates a summary, action items and an after-meeting agenda with Claude.

## Setup (Windows 10 or 11)

1. Install Node.js 22 or newer from nodejs.org.
2. Unzip this folder anywhere.
3. Double-click `start.bat`. The first run installs dependencies, which takes a few minutes. Or run `npm install` then `npm start` in a terminal.
4. Open Settings, paste your Anthropic API key, and press Test key.

## Using it

1. New meeting: enter a title, attendees and the planned agenda (optional).
2. Start meeting: the first start downloads the speech model once, then runs on your computer. Windows will ask for microphone access.
3. During the meeting: the live transcript shows "You" (your microphone) and "Others" (system audio from Zoom, Teams, Meet and similar). Type quick notes at any time.
4. End meeting, then open Summary and agenda and press Generate. You get:
   - executive summary
   - decisions
   - action items with owner, due date and priority
   - risks and open items
   - coverage of your planned agenda
   - a proposed agenda for the follow-up meeting
   - missing information
5. Export as Markdown or PDF, copy the Markdown, or export the transcript as text.

Anything the meeting did not state is marked "Data to be confirmed" instead of guessed. Regenerate with an optional instruction, for example "focus on budget and schedule items".

## Features

### Floating recording widget
- While a meeting is live, a small player-style widget sits in a screen corner: pulsing REC dot, timer, level meter, pause/resume, stop, open-app.
- It stays above all other windows, does not take focus, and can be dragged; it snaps to the nearest corner on release.
- Sizes: **Bar** (default), **Card** (adds meeting title, last transcript line, You/Others activity), **Dot** (tiny; click to expand).
- Appearance: **Solid** or **Transparent** (glass look that fades to your chosen opacity when the pointer is away).
- "Minimize to corner" in the meeting header shrinks the main window out of the way. Closing the widget never stops the meeting.
- "Pin on top" in the header keeps the main window above everything too.
- Pause/resume stops capturing without ending the meeting; the timer freezes.
- Settings > Floating widget: appearance, opacity, size, corner, auto-show, and a Preview button.

### App updates from GitHub
- GitHub is used only to distribute app updates from [levanis-design/MeetNotes](https://github.com/levanis-design/MeetNotes).
- In the installed Windows app, open **Settings > App updates > Check for updates**.
- If a newer version exists, choose **Download update**, then **Restart and install**. Installation happens only after you confirm the restart; closing the app does not install an update automatically.
- End your meeting before checking, downloading or installing an update.
- No GitHub account or personal access token is needed. The app never uploads summaries, meetings, notes or transcripts to GitHub.
- Local Markdown, PDF and transcript exports remain available.
- The old 1.1.0 installer has no updater. Install 1.2.0 once from [GitHub Releases](https://github.com/levanis-design/MeetNotes/releases); future releases can be installed through the app.
- When running from source with `npm start`, use **View releases** or update the source with Git. In-app installation is for packaged Windows builds.
- On upgrade, the app removes its saved GitHub publishing token and repository preferences. Your meetings and Anthropic key are kept. Content published with an older version remains in the destination repository until you delete it there.

## Privacy

- Audio is never saved. Only recognized text is stored, in `%APPDATA%\meetnotes`.
- Speech recognition runs on your computer.
- Generating a summary sends that meeting's transcript, notes and agenda text to the Anthropic API. Meeting content is sent to Claude only when you press Generate.
- Your API key is encrypted with Windows secure storage.
- Update checks and installer downloads contact GitHub without including meeting content.
- Settings has a button to delete all meetings.
- Tell participants you are recording notes. Some states require everyone's consent to record.

## Limits to know about

- "Others" is one combined speaker. It cannot tell individual participants apart, so names come only from what is said or typed.
- Transcription is cut at natural pauses and may have errors in names and numbers. The summary flags uncertain ones.
- The windows are not hidden from screen sharing. This app is built for your own notes, not for covert use.
- If your network blocks nuget.org or huggingface.co, installation or the first speech-model download will fail. Both are one-time downloads.

## Validation and preview status

The real GitHub update feed, installer download and checksum verification pass. Windows packaging, Electron UI/IPC, PDF/Markdown/text exports, floating-widget creation and always-on-top, and recording lifecycle with simulated audio have been tested. Real Whisper model loading and CPU inference pass, including from the packaged app, using synthetic silence. Live microphone/loopback capture, real-speech accuracy, Claude API summaries, a complete installed-app upgrade, transparency, dragging and DPI scaling still require live checks. See [REVIEW.md](REVIEW.md) and [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Development

- `npm test` runs the logic tests (storage, rendering, AI parsing, audio segmentation).
- `node --test tests/capture.test.js` runs audio-cleanup and worker-disposal regressions.
- `npx electron tests/electron-smoke.cjs` runs isolated desktop integration checks. Add `--packaged` after building to test the packaged source.
- `node tests/transcription-smoke.cjs` downloads the model into isolated test data and runs real CPU inference on silence.
- `npx electron tests/packaged-transcription.cjs` checks packaged speech-worker inference after a build.
- `npx electron tests/update-feed-smoke.cjs` checks the published 1.2.0 feed and downloads/checksums the installer into isolated test data without installing it.
- `npm run dist -- --publish never` builds the verified Windows installer without automatic publishing.
- Code layout: `src/` main process, `renderer/` interface and audio capture.

## Publishing app updates

The Windows NSIS installer uses `electron-updater` with the public GitHub Releases feed. A release must contain the installer, its `.blockmap` file and `latest.yml`; the metadata names the installer and its SHA-512 checksum. See the [electron-builder update documentation](https://www.electron.build/v26/docs/features/auto-update/).

1. Bump `version` in `package.json` and refresh the lockfile with `npm install --package-lock-only`.
2. Update `RELEASE_NOTES.md`, run the tests and desktop smoke checks, and commit the changes.
3. Push the commit and a matching tag, for example `v1.2.1` for version `1.2.1`.
4. The **Publish Windows release** GitHub Actions workflow tests and builds the app, then publishes the installer and update metadata using the repository's Actions token. Users do not need that token.
5. Verify the release contains all three assets and test checking/downloading from an older installed version before announcing it.

Only published releases are used for updates; drafts and prereleases are skipped. The app does not downgrade. Existing local meetings and settings remain in the same user-data directory. The installer is currently unsigned; Windows code signing remains a recommended follow-up before wider distribution.
