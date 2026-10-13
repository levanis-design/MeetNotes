# MeetNotes v1.1.0

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

## New in 1.1.0

### Floating recording widget
- While a meeting is live, a small player-style widget sits in a screen corner: pulsing REC dot, timer, level meter, pause/resume, stop, open-app.
- It stays above all other windows, does not take focus, and can be dragged; it snaps to the nearest corner on release.
- Sizes: **Bar** (default), **Card** (adds meeting title, last transcript line, You/Others activity), **Dot** (tiny; click to expand).
- Appearance: **Solid** or **Transparent** (glass look that fades to your chosen opacity when the pointer is away).
- "Minimize to corner" in the meeting header shrinks the main window out of the way. Closing the widget never stops the meeting.
- "Pin on top" in the header keeps the main window above everything too.
- Pause/resume stops capturing without ending the meeting; the timer freezes.
- Settings > Floating widget: appearance, opacity, size, corner, auto-show, and a Preview button.

### Publish to GitHub
- Summary and agenda tab > **Publish to GitHub** saves `meetings/YYYY-MM-DD-title/summary.md` (and optionally `transcript.txt`) into a repository.
- Republishing the same meeting updates its files instead of duplicating them.
- Default is a **private** repository. The app refuses to write to a public repository unless you chose Public and confirm the warning. The transcript is off by default.
- Token setup: Settings > GitHub. Simplest safe route: create an empty private repo on github.com, then a fine-grained token limited to that repo with Contents set to read and write. Letting the app create repos needs extra permission; the exact permission name is data to be confirmed, so a classic token with the `repo` scope is the fallback. The token is stored encrypted and never shown again.

## Privacy

- Audio is never saved. Only recognized text is stored, in `%APPDATA%\meetnotes`.
- Speech recognition runs on your computer.
- Generating a summary sends that meeting's transcript, notes and agenda text to the Anthropic API. Nothing is sent until you press Generate.
- Your API key is encrypted with Windows secure storage.
- Settings has a button to delete all meetings.
- Tell participants you are recording notes. Some states require everyone's consent to record.

## Limits to know about

- "Others" is one combined speaker. It cannot tell individual participants apart, so names come only from what is said or typed.
- Transcription is cut at natural pauses and may have errors in names and numbers. The summary flags uncertain ones.
- The windows are not hidden from screen sharing. This app is built for your own notes, not for covert use.
- If your network blocks nuget.org or huggingface.co, installation or the first speech-model download will fail. Both are one-time downloads.

## Validation and preview status

Windows packaging, Electron UI/IPC, PDF/Markdown/text exports, floating-widget creation and always-on-top, and recording lifecycle with simulated audio have been tested. Real Whisper model loading and CPU inference pass, including from the packaged app, using synthetic silence. Live microphone/loopback capture, real-speech accuracy, Claude API summaries, GitHub publishing from the app, transparency, dragging and DPI scaling still require live checks. This release is a preview. See [REVIEW.md](REVIEW.md) and [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Development

- `npm test` runs the logic tests (storage, rendering, AI parsing, audio segmentation).
- `node --test tests/capture.test.js` runs audio-cleanup and worker-disposal regressions.
- `npx electron tests/electron-smoke.cjs` runs isolated desktop integration checks. Add `--packaged` after building to test the packaged source.
- `node tests/transcription-smoke.cjs` downloads the model into isolated test data and runs real CPU inference on silence.
- `npx electron tests/packaged-transcription.cjs` checks packaged speech-worker inference after a build.
- `npm run dist -- --publish never` builds the verified Windows installer without automatic publishing.
- Code layout: `src/` main process, `renderer/` interface and audio capture.
