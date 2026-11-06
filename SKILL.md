---
name: must-bee
description: M.U.S.T. Moodle courseware sync and timetable query. Use when the user asks about M.U.S.T. courses, schedule, assignment deadlines, announcements, or downloaded course materials.
metadata:
  emoji: 🎓
  requires:
    env: [MUSTER_USERNAME, MUSTER_PASSWORD]
  defaults:
    MUSTER_DOWNLOAD_PATH: ~/.must-bee/wemust
---

# must-bee 🐝

Every command prints one JSON object/array to stdout. Errors go to stderr as
`{"error": "...", "partialReport"?: ...}` with a non-zero exit.

Full flag reference: `node scripts/muster_cli.js --help`.

## When to use which command

| User intent | Command |
|---|---|
| First-time setup / "全量同步" | `sync --all` (once), then plain `sync` for ongoing |
| "今天/本周课表" | `schedule` (add `--week` for the full week) |
| "我有哪些课" | `courses` (add `--live` to ignore the cache) |
| "X 课最近上传了什么" | `course --code X` |
| "这份作业要求/交了没/附件" | `assign --code X [--name LAB3]`, or `assign --url <url>` |
| "公告说了什么 / 考试通知" | `post --code X [--name midterm]`, or `post --url <discuss.php url>` |
| "把这门课所有公告翻一遍" | `forum --code X --bodies` |
| "这门课有哪些活动/链接" | `links --code X` |
| "下载这个文件" | `get --url <pluginfile url> [--out DIR]` |
| "有什么作业要交" / deadline | `pending [--course X]` |
| "下次上 X 课要看什么材料" | `files --course X --date <next-class-date>` |
| "同步到哪一步了" | `status` |
| "把课件总结成 Obsidian 笔记" | `notes [--course X] [--dry-run] [--force] [--limit N]` |

`courses` reads the local cache (auto-runs `sync --all` once if empty).
`course --code` always fetches the course content live (URL is resolved from cache first; falls back to a live Moodle dashboard scan if the course isn't cached).
`pending`, `assign`, `post`, `forum`, `links`, `get` always hit Moodle.
`schedule` and `files --course --date` read from cache when they can, and fetch from Moodle when the requested range isn't covered.

## Commands

All commands below are prefixed by `node scripts/muster_cli.js`.

```bash
# Incremental sync
sync                     # current week's timetable-linked courses
sync --week [DATE]       # full week (default: this week)
sync --all               # every course in the current term

# Timetable
schedule                 # today (Asia/Macau)
schedule --date DATE     # one specific day
schedule --week [DATE]   # full week

# Course listing and detail
courses [--live]         # list every enrolled course (cache; --live scans Moodle)
course --code CODE       # one course's assignments + quizzes + materials + announcements (live)
links --code CODE        # every activity/resource link (mod/url, mod/page, mod/label too)

# Assignments, announcements, files
assign --url URL | --code CODE [--name TEXT]     # description / submission status / attachments
post   --url URL | --code CODE [--name TEXT]     # full announcement body
forum  --url URL | --code CODE [--bodies]        # every thread in every forum
pending [--course CODE]
files  [--course CODE] [--date DATE]             # --course --date: files between previous class and DATE
files --recent [--n N]                           # N most recently synced (by local sync time, not upload date; default N=10)
get --url URL [--out DIR]                        # download one Moodle file via the logged-in session

# Obsidian review notes
notes                                  # generate review notes for downloaded PDF/PPTX without a note yet
notes --course CODE                    # only that course
notes --dry-run                        # list what would be generated (no LLM calls)
notes --force                          # regenerate existing notes
notes --limit N                        # at most N files

# State
status

# Debug / version
<any-command> --debug                  # stream [debug] traces to stderr
--version | --help
```

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `MUSTER_USERNAME` | yes* | — | portal username |
| `MUSTER_PASSWORD` | yes* | — | portal password |
| `MUSTER_DOWNLOAD_PATH` | no | `~/.must-bee` | files land in `<root>/wemust/` |
| `MUSTER_NO_SANDBOX` | no | `0` | `1` disables the Chromium sandbox (containers/root only) |
| `MUSTER_MAX_DOWNLOAD_MB` | no | `200` | cap for external announcement links |
| `MUSTER_PYTHON` | no | `python3` | interpreter for `notes` |
| `DEEPSEEK_API_KEY` | for `notes` | — | note generation |
| `DEEPSEEK_API_BASE` | no | `https://api.deepseek.com` | DeepSeek-compatible endpoint |
| `DEEPSEEK_MODEL` | no | `deepseek-chat` | model for notes |
| `OBSIDIAN_VAULT_PATH` | for `notes` | first existing of `~/Vaults/Obsidian`, `~/Obsidian` | notes go to `Courses/<course> <code>/` |
| `MUST_BEE_ENV` | no | — | extra `.env` file loaded by `notes` |

\* Cache-only commands (`status`, `files` without `--date`) work without credentials.

## Notes for agents

- **Ask the user for credentials** if `MUSTER_USERNAME` / `MUSTER_PASSWORD` are missing. Never invent them. Never echo the password back to the user or into a log.
- **Parse stdout as JSON**, not as human text. stderr carries error JSON separately.
- **Partial failure** returns `{"error": "...", "partialReport": {...}}` with exit code 1 — surface the partial results to the user; don't treat it as a total failure.
- **Cache vs network:**
  - **Always offline (cache only):** `status`; `files` without `--date` (bare, `--course CODE`, or `--recent`)
  - **Always online:** `sync`, `course --code`, `assign`, `post`, `forum`, `links`, `get`, `pending`
  - **Online only when needed:** `schedule` (fetches if the requested day/week isn't cached), `courses` (only on first run when cache is empty), `files --course --date` (only when timetable doesn't cover the lookback window)

  For "always online" commands, suggest `sync` first if the user expects fresh data anyway.
- **Downloads are limited to PDF / PPT / PPTX**; other extensions are skipped by design.
- **Download layout:** `mod/folder` resources are downloaded recursively (folder structure preserved); `mod/assign` resources get a named subfolder with intro attachments; other modules are top-level files.
- **Announcements (mod/forum) are scanned too:** recent discussion posts are opened and (a) Moodle pluginfile attachments and (b) external links (Dropbox / Google Drive / OneDrive / MEGA / WeTransfer — plain-text URLs included) are collected and downloaded. Dropbox share links are auto-converted `dl=0` → `dl=1`; folder shares (zip) are auto-extracted for PDF/PPT/PPTX. External downloads are capped at `MUSTER_MAX_DOWNLOAD_MB` (default 200 MB) and zip extraction is bounded (500 entries / 100 MB each / 300 MB total).
- **`get` is restricted to `*.must.edu.mo`** — it refuses to act as an authenticated proxy for arbitrary URLs.
- **Course codes are derived from names** like `2609-CS482EX1-5A7EE7` → `CS482`, so `--code` works even for courses first seen through `sync --all`.
- **Obsidian review notes (`notes`):** generated per courseware file into the vault's `Courses/<course> <code>/<date> <file>.md` with frontmatter `type: courseware-note`, `tags: [courseware, <code>]`. Q&A lines use `Q :: A` and cloze `==answer==` — both plain-text readable and compatible with the obsidian-spaced-repetition plugin if installed. Requires python3 with PyMuPDF + python-pptx + requests and `DEEPSEEK_API_KEY` (environment, repo `.env`, or `~/.hermes/.env`). Extracted courseware text is sent to the configured LLM — do not run on confidential material unless the endpoint is local. Review dashboards live in `Courses/复习面板.md` (dataview).
- **DNS caveat:** some campus networks stall the OS resolver (mDNSResponder) on CDN domains like dropbox.com (`curl` reports "Resolving timed out" while `nslookup` works). must-bee downloads external links via direct DNS queries (Node `dns.Resolver`), so this is handled. For manual downloads use `curl --resolve host:443:<ip-from-nslookup>`.
- Files live under `$MUSTER_DOWNLOAD_PATH/wemust/<course-folder>/`.

## Output shapes

All commands print one JSON value to stdout. Key shapes for parsing:

| Command | Shape |
|---|---|
| `sync` | `{ runAt, scope, termCode, timetableCourses[], matchedCourses[], scannedCandidates, counts: { added, updated, unchanged, failed }, downloaded[], errors[], timetableFromCache, forWeek? }` |
| `schedule` | `{ termCode, fromCache, range, lessons[] }` (lesson fields come straight from the timetable API: `courseCode`, `courseName`, `courseEnName`, `lessonDate`, plus extras) |
| `courses` | `{ source: 'cache' \| 'fresh-sync' \| 'live', termCode, total, courses[] }` — course: `{ courseCode, courseName, moodleUrl, files, lastSynced }` |
| `course` | `{ courseCode, courseName, moodleUrl, assignments[], quizzes[], materials[], announcements[] }` — material entries: `{ name, url, updated }`; announcement: `{ forumUrl, forumName, posts[] }` (post: `{ title, url, date, attachments }`) |
| `assign` | `{ url, title, description, status, fallback, pageDebug, attachments[], course?, allAssignments? }` — attachment: `{ name, url, normalizedUrl }` |
| `post` | `{ url, pageTitle, title, posts[], fallback, counts }` — post: `{ subject, author, date, body }` |
| `forum` | `{ course, forums[] }` — forum: `{ forumUrl, forumName, subForumCount, threadCount, threads[] }`; thread with `--bodies`: `{ title, url, author, date, body, replies[] }` |
| `links` | `{ course, count, items[] }` — item: `{ type, name, url, updated }` |
| `get` | `{ url, saved, bytes }` |
| `pending` | `{ total, events[] }` — event: `{ name, dueDate, course, courseUrl, eventType, url }` |
| `notes` | `{ vault, generated[], errors[] }` — generated: `{ course, courseCode, file, note, chars }` (dry-run: `{ vault, tasks[] }`) |
| `files` (bare or `--course`) | array of `{ courseCode, courseName, moodleUrl, filename, uploadDate, path }`, sorted by `uploadDate` ascending |
| `files --course --date` | `{ fromCache, prevDate, files[] }` — file: `{ filename, uploadDate, path }` |
| `files --recent` | array of `{ courseCode, courseName, filename, uploadDate, firstSeen, path }`, sorted by `firstSeen` descending |
| `status` | `{ totalCourses, totalFiles, lastSynced, timetable, courses[], wemustRoot }` — `timetable: { termCode, weeksCached, earliest, latest } \| null` |
| (any) error | `{ error: string, partialReport?: object }` on stderr, exit code 1 |
