# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.1.0] — 2026-11-06

### Security

- Updated `adm-zip` to `^0.6.1`, fixing multiple high-severity advisories
  (symlink extraction, decompression-bomb bypass, memory DoS).
- Added hard bounds to external downloads (200 MB default, configurable) and zip
  extraction (500 entries / 100 MB per entry / 300 MB total).
- External announcement hosts are now matched on domain-label boundaries, so
  lookalike domains such as `evil-dropbox.com` are rejected.
- `get` now refuses non-`*.must.edu.mo` URLs instead of acting as an
  authenticated open proxy, and never overwrites an existing file.
- Chromium's sandbox is enabled by default; `MUSTER_NO_SANDBOX=1` is an
  explicit opt-out.
- The `notes` Python child no longer inherits `MUSTER_PASSWORD`.
- `safeFilename` now strips control characters, leading dots, and Windows
  reserved device names, and preserves the extension when truncating.
- `notes.py` validates that reads/writes stay inside the download root and the
  vault's `Courses/` directory, quotes YAML frontmatter safely, and writes notes
  atomically.

### Fixed

- `Content-Range` responses no longer make every file look one byte long and
  trigger spurious re-downloads.
- Upload dates are formatted in `Asia/Macau` instead of UTC, so late-night
  uploads no longer move to the previous day.
- `course --code` works for courses first seen through `sync --all`: the code is
  derived from names like `2609-CS482EX1-5A7EE7`.
- `sync --all` no longer lists the Moodle dashboard twice when inferring the
  term.
- `files --recent --n` falls back to 10 instead of returning an empty list for
  invalid input.
- The download-relink fallback no longer interpolates a URL into a CSS selector.

### Changed

- Pure helpers moved to `scripts/lib/core.js`; network/zip helpers moved to
  `scripts/lib/net.js`. The CLI is ~400 lines shorter.
- Unit tests import the real modules instead of copying implementations;
  coverage grew from 55 to 96 tests.
- `package.json` now points at `Frankynwa/must-bee`, adds a `must-bee` bin,
  `engines`, `files`, and `check`/`prepublishOnly` scripts.
- README (EN/CN) and SKILL.md rewritten: all commands, configuration, security
  notes, attribution.
- Added `.env.example`, `requirements-notes.txt`, `SECURITY.md`,
  `CONTRIBUTING.md`, CI, and issue templates.

## [2.0.0] — 2026-09-04

### Added

- Renamed from `muduo` to `must-bee` (MUST + must-be).
- Announcement/forum scanning, including external courseware links.
- `assign`, `post`, `forum`, `links`, `get` commands.
- `notes`: Obsidian review notes from PDF/PPTX via DeepSeek.
- Timetable capture via an XHR hook instead of webpack module names.

## [0.1.0] — 2026-05-23

- Initial `muster_skill` by Cosmostima: sync, schedule, courses, pending, files,
  status.
