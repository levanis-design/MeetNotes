# MeetNotes update review — October 17, 2026

Reviewed the `meetily-ideas` update: silence filtering, summary templates, long-transcript summaries, saved meeting audio, recording import, recovery and re-transcription. Package version remains 1.4.0; publishing a new installer release is separate from uploading the source.

## Review fixes

- Block creating a meeting, deleting meeting data and installing app updates while saved audio is being transcribed. Recheck the selected meeting after loading audio metadata to avoid a navigation race.
- Preserve the full text of oversized transcript lines instead of silently truncating them, while respecting the per-part request size.
- Report failures when starting or appending saved audio. Stop appending after a failed chunk because later WebM chunks depend on it.
- Show the correct default audio-retention disclosure before settings finish loading. Deletion confirmation explicitly includes saved audio.
- Keep recovery warnings attached to their meeting when navigating.
- Isolate UI smoke tests from background model preloading after a GitHub runner crashed during shutdown after printing PASS. Real model loading and inference remain separately tested.
- Clarify the limits of long-meeting summaries and prompt-injection instructions in the release notes.

## Validation

- A real `npm ci` completed successfully.
- All 106 automated tests passed, including regressions for oversized transcript lines and audio-save failures.
- Source desktop checks passed. They record a synthetic tone through the real browser MediaRecorder, persist it, decode it, start a saved-audio job and confirm that new meetings and data deletion are blocked until cancellation finishes. No real microphone or account is used.
- Real Whisper model loading and CPU inference on synthetic silence passed with the updated speech worker.
- The Windows NSIS installer built, and `tools/verify-release.cjs` verified its version, SHA-512, metadata filename and blockmap.
- Packaged desktop checks passed: the new modules match reviewed source, and the same audio persistence and cancellation workflow passes. Packaged worker dependencies and CPU inference also passed.
- Production dependency audit: zero reported vulnerabilities. Full dependency installation reports eight moderate advisories in development/build tooling; no forced dependency downgrade was applied.
- Source credential-pattern scan found no obvious API keys, GitHub tokens or private keys. Test data, audio used in tests, model caches and installers remain excluded from Git.

## Remaining live checks and limitations

- Test real microphone and Windows loopback capture, pause/resume, headset changes and recording recovery after a real crash. Synthetic tone and silence checks do not establish speech-recognition accuracy or crash recovery on every device.
- Test the chosen AI provider with an approved real meeting, including a long meeting and a failed request. The summary tests use simulated provider responses.
- Verify live Outlook access and a real install/upgrade on a clean Windows computer. The installer remains unsigned.
- Saved audio is enabled by default and kept locally; Settings can disable future recording saves. Deleting a meeting removes its saved audio. Imported files stay in their original location and are not deleted.
- Recovery skips a segment if it already contains a transcript line from the same source; it cannot establish that every word in that segment was captured. Use full re-transcription if a partially transcribed segment is incomplete.
- Audio import decodes a whole file in memory. Very long recordings can require substantial memory even when their compressed file is below the 1 GB import limit.
- Exceptionally large notes or condensed transcripts can still exceed a model's request limit. Prompt instructions reduce injection risk but cannot guarantee AI behavior.
