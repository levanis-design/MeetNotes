# MeetNotes release readiness review

Reviewed on October 13, 2026. Package version: 1.4.0. Source branch: `features-edit-search-export-week`.

## Result

The reviewed source passes the checks below, and the Windows installer builds successfully. This is not a guarantee that the app is free of defects. The account, hardware and installation checks below remain necessary before a public release.

## Fixed during this review

- Prevented delayed note and summary responses from appearing in a different meeting after navigation; added desktop regressions. Note submission clears immediately to prevent duplicate clicks and reports save failures.
- Made concurrent meeting navigation keep the most recently requested meeting.
- Deleted damaged recovery copies when deleting a meeting, and excluded those files from Git.
- Corrected stale task due-date labels when changing or clearing an uncertain date.
- Preserved API endpoint query parameters, including Azure API-version parameters. Keyless requests require an exact loopback hostname; Azure headers are selected by hostname.
- Added a single-instance lock to prevent multiple app processes from writing the same data files.
- Included a Windows ICO asset to avoid a PNG conversion failure caused by an unrelated ancestor package's module setting on this computer.
- Added desktop regression checks to both GitHub Actions workflows.

## Verified on this checkout

- `npm test`: 82 tests passed, zero failures.
- `electron tests/electron-smoke.cjs`: passed, including delayed note/summary navigation regressions, dashboard/tasks, meeting editing, PDF exports, widget and recording lifecycle with simulated capture.
- `npm run dist -- --publish never`: built the Windows NSIS installer, blockmap and update metadata.
- `node tools/verify-release.cjs`: verified version, installer SHA-512, metadata filename and blockmap; created the release asset aliases.
- `electron tests/electron-smoke.cjs --packaged`: passed against packaged source.
- `node tests/transcription-smoke.cjs`: real model loading and CPU inference passed on synthetic silence.
- `electron tests/packaged-transcription.cjs`: packaged worker dependencies and CPU inference passed.
- `npm audit --omit=dev`: zero reported production dependency vulnerabilities.
- Credential-pattern scan of source found no obvious real API keys, GitHub tokens or private keys. Local data, model cache, dependencies and installers are ignored by Git.
- `git diff --check`: passed.

The expected Outlook configuration error in the smoke test is intentional: no real Microsoft account was connected. Synthetic silence validates model loading, not recognition accuracy. Tests ran on local Node 24; the configured Node 22 GitHub Actions jobs have not run for these changes.

## Remaining findings and live checks

- Full `npm audit` reports seven moderate entries in the Electron Builder dependency chain, all tracing to `sprintf-js` through build-time proxy logging. The advisory lists no patched version: https://github.com/advisories/GHSA-hp3w-g68c-fv3c. No forced downgrade was applied. The production audit is clean.
- Test a real microphone and Windows loopback call, including headset changes, pause/resume and minimizing. Check names, numbers and transcript completeness.
- Test the selected AI connection with an approved meeting and a failed network request. API/CLI behavior is covered with fakes, not a live paid account.
- Connect the intended Outlook account or desktop Outlook and verify organisational consent, events and Join links.
- Install on a clean Windows machine without Node.js, then test an actual restart/install upgrade from the previous version.
- Check widget scaling and positioning on multiple monitors.
- The installer is unsigned. Code signing and a complete local backup/restore feature remain useful follow-ups.

## GitHub state

The remote head lookup returned only `main` at `d326168`; local HEAD was `3032d7f` before this review. The newer 1.4.0, reliability and editing/search commits are local. Review fixes are uncommitted on the existing feature branch. No push, tag, merge or release publication was performed during this review.

MeetNotes does not publish meeting content to GitHub. GitHub distributes app binaries and update metadata.
