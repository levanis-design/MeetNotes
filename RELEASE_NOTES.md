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
