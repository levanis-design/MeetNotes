# MeetNotes v1.1.0 Windows preview

Personal Windows meeting tracker with local Whisper transcription, notes, Claude summaries, PDF/Markdown exports, and a floating recording widget.

## Fixes in this preview

- Meeting edits save against the meeting being edited and no longer overwrite another meeting after switching.
- Recording startup and shutdown block meeting switching, deletion, and duplicate recording commands.
- Failed audio startup releases streams and the audio context.
- Microphone and system-audio inference requests run sequentially in the speech worker.
- Worker disposal rejects pending readiness requests instead of leaving them hanging.
- Summary generation waits until recording ends and cannot replace a different selected meeting.

## Validation

- Logic and failure-path regression tests pass.
- Electron smoke test covers creation, edits, notes, Markdown/text/PDF exports, floating widget and pause/resume/stop with simulated capture.
- Real Whisper model loading and CPU inference pass in development and from the packaged app, using synthetic silence.
- Windows x64 NSIS installer builds successfully.
- Production dependency audit reports no known vulnerabilities.

## Before relying on it for a meeting

Verify microphone and system audio on your own Zoom/Teams/Meet setup, transcription accuracy on real speech, and Claude summary generation using your API key. Those live integrations have not been end-to-end verified. The installer is unsigned and uses the default Electron icon. This is a preview release.

Download `MeetNotes-Setup-1.1.0.exe` from the release assets. Speech-model files are downloaded on first use; the installer does not bundle them.
