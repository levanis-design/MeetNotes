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
