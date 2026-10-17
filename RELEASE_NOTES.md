# Unreleased

## Transcription
- Silence and background noise are filtered out before speech recognition (Silero voice detection), which stops made-up lines such as "Thank you for watching". The filter model downloads once with the speech model; if it cannot load, transcription works as before. Settings > Speech can turn it off.
- Meeting audio is saved compressed every 30 seconds (on by default, Settings > Speech). After a crash, "Recover missing speech" under the transcript transcribes only the parts that have no lines yet. "Transcribe again" redoes the whole meeting, for example with a more accurate speech model. "Delete audio" removes the audio and keeps the transcript.
- "Import recording" transcribes an audio or video file (MP3, WAV, M4A, MP4, WebM and others). Lines from a recording are labelled "Recording".

## Summaries
- Summary templates: Standard, Daily standup, Project status, Client or vendor call, One-to-one and Retrospective. Each adds sections for that kind of meeting, and you can add your own as JSON files (Settings > AI summary > Open templates folder). Pick the template on each meeting's Summary tab.
- Long meetings no longer fail as too long: they are condensed in parts and then summarized. Local models (Ollama, LM Studio) get smaller parts.
- The AI is told to ignore instructions spoken in the meeting, so a line such as "ignore previous instructions" in the transcript cannot change the summary rules.

## Notes and transcripts
- Correct a transcript line by clicking it. Clearing the text removes the line. Corrected lines are marked "edited" and the summary uses the corrected text.
- Search looks inside every meeting: titles, attendees, agenda, notes, transcript lines and summaries. Results show where the match is and a highlighted excerpt.
- "Export summary and transcript" saves one Markdown or text file with the summary, agenda, notes and full transcript.

## Weeks
- Weeks start on Monday by default (Settings > You and your tasks > Week starts on). Weekly progress, this week's action items and the calendar follow the setting.

## Reliability
- Delayed notes and summaries stay attached to the correct meeting when switching views. Only one MeetNotes process can write to local data at a time.
- Deleting a recovered meeting also removes its damaged recovery copy. Clearing an uncertain task due date removes its old label.
- API addresses retain query parameters, including Azure API-version parameters. Windows builds use an included ICO icon.
- Meetings, tasks and settings keep the previous version on every save and recover it if a file is damaged.
- Speech recognition restarts if it stops responding. Ending a meeting waits at most 90 seconds for queued speech. Transcription backlog is capped on slow computers.

# MeetNotes v1.4.0

## AI summary connections

- Choose the AI that writes the summary in Settings: Claude with an Anthropic API key, Claude Code on this computer (Claude subscription, no key), Codex CLI on this computer (ChatGPT sign-in, no key), or OpenAI, Azure OpenAI, a company gateway or a local model through an OpenAI-compatible API.
- "Copy prompt for any AI" and "Paste AI reply" on the Summary tab work with any tool, such as Microsoft Copilot, ChatGPT, Claude.ai or Gemini.
- API calls use the Windows certificate store and proxy, so they work behind corporate SSL inspection.

## Easier Outlook calendar

- "Use Outlook on this computer" reads the calendar from classic Outlook for Windows. No sign-in, app registration or administrator approval. Read-only.
- The Microsoft sign-in and published calendar link remain available under other options.

## Speech recognition

- Model downloads use Electron's network stack and work behind corporate SSL inspection. Download errors now show the address and reason.
- The speech model loads in the background at startup and is warmed up, so Start is immediate.
- Full-precision encoder with a quantized decoder for better accuracy.
- Segments start 0.3 seconds before speech, adapt to background noise, cut long speech at the quietest point and boost quiet audio.
- Repeated-phrase loops and common filler hallucinations are removed.
- The microphone reconnects after a headset or Bluetooth change, failed segments are retried once, and a backlog warning appears when transcription falls behind.

## Installer

- Windows installer lets you choose the install folder and adds desktop and Start menu shortcuts.
- New app icon.
- `build-installer.bat` builds the installer locally in one step.

# MeetNotes v1.3.0

## New features

- Dashboard with recent meeting notes, weekly progress, latest summaries and upcoming meetings.
- Local task list with priorities, due dates, completion and automatic imports from summary action items.
- Read-only Outlook calendar via Microsoft device-code sign-in, or a published ICS calendar link.
- Calendar navigation, supported meeting-service Join links, and notes prefilled from calendar events.

## Verification fixes and retained behavior

- Kept GitHub app updates and excluded publishing of meeting content.
- Kept the prior audio cleanup, worker queuing, field-saving and recording-transition fixes.
- Fixed canceled Outlook sign-in continuing after a network response.
- Fixed stale calendar responses overwriting newer requests or repopulating a cleared cache.
- Preserved all-day calendar dates using the original time zone, including Windows names and extreme UTC offsets.
- Updated README setup, privacy and update instructions.

## Install or update

Install `MeetNotes-Setup-1.3.0.exe`, or use Settings > App updates in version 1.2.0. Local meetings and settings are preserved. No GitHub account or token is required for updates.

## Validation

51 automated tests pass. Desktop checks cover dashboard/task entry and completion, meeting editing, exports, widget and recording lifecycle with simulated audio. Real Outlook sign-in, organisation-specific consent, meeting audio, Claude calls and a full restart/install upgrade still require verification on your setup. The installer remains unsigned.
