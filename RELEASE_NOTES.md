# MeetNotes v1.2.0

## Changes

- Removed publishing meeting summaries and transcripts to GitHub, including token setup, repository preferences and publishing history in the interface.
- Added Settings > App updates: check GitHub Releases, download an update, then confirm restart and installation.
- Updates come from levanis-design/MeetNotes. No GitHub login or token is required.
- Updates are blocked while a meeting is recording. Updates are not downloaded or installed automatically.
- Upgrading removes obsolete saved publishing credentials while keeping meetings and the Anthropic key.
- Added a Windows release workflow that publishes the installer, blockmap and latest.yml update metadata.
- Updated the README with privacy, update and release instructions.

## Installation

Install `MeetNotes-Setup-1.2.0.exe` once to switch from 1.1.0, which has no updater. Future versions can be installed from Settings > App updates.

## Validation and remaining checks

The automated suite covers storage, exports, audio cleanup and the update lifecycle, recording guards, duplicate operations, failure recovery and credential migration. Desktop and package smoke checks cover the interface and local transcription. A complete restart/install upgrade on an installed Windows app still needs verification. Live meeting audio and Claude calls also require your real-session check. The installer remains unsigned.
