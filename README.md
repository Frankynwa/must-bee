# must-bee 🐝

**M.U.S.T. Moodle + timetable, as JSON your agent can drive.**

> *"Did the lecturer upload new slides again?"*
> *"Which assignment is due tomorrow, again?"*
> *"Do I even have class tonight?"*
>
> Skip the wemust login — just ask your AI.

**Languages:** [English](./README.md) · [中文](./README_CN.md)

[![CI](https://github.com/Frankynwa/must-bee/actions/workflows/ci.yml/badge.svg)](https://github.com/Frankynwa/must-bee/actions/workflows/ci.yml)

---

> [!WARNING]
> **Unofficial project.** must-bee is not affiliated with or endorsed by Macau
> University of Science and Technology. It automates a student's own Moodle and
> timetable sessions. Automated access may violate your university's acceptable
> use policy — check before using it, and use it at your own risk.

## What it does

must-bee logs into the M.U.S.T. CAS portal with Playwright, then exposes Moodle
and the class timetable as a small CLI where **every command prints one JSON
value to stdout**. Any tool-using agent (Claude Code, Hermes, Codex, a custom
script) can drive it without parsing HTML.

- 🔄 **Incremental sync** — only downloads new or changed courseware
- 📅 **Timetable** — today, a specific date, or a whole week
- 📚 **Courses & materials** — every enrolled course, assignment, quiz and file
- 📝 **Deadlines** — upcoming Moodle calendar events
- 📄 **Assignments** — description, submission status and attachments
- 📢 **Announcements** — forum post bodies, including exam notices
- 🔗 **External courseware** — Dropbox / Google Drive / OneDrive / MEGA / WeTransfer links in announcements
- 🧠 **Obsidian notes** — optional: turn PDF/PPTX courseware into review notes with DeepSeek
- 🧱 **JSON-first** — stable output shapes for agents

## Quick start

```bash
git clone https://github.com/Frankynwa/must-bee.git
cd must-bee
npm install
npx playwright install chromium

cp .env.example .env
# edit .env: MUSTER_USERNAME / MUSTER_PASSWORD

set -a && . ./.env && set +a
node scripts/muster_cli.js sync --all   # first full sync
node scripts/muster_cli.js schedule     # today's classes
```

Or install it as a skill — paste this into your agent:

````text
Please install the must-bee skill for me: https://github.com/Frankynwa/must-bee

Follow this workflow:
1. Clone the repo into your skills directory
2. cd in and run `npm install && npx playwright install chromium`
3. Ask me for my MUSTer credentials (do not invent them), then put them in .env as
   MUSTER_USERNAME / MUSTER_PASSWORD
4. Run `node scripts/muster_cli.js status` to verify it works
5. Tell me how I can start using it
````

## Commands

All commands are `node scripts/muster_cli.js <command>`. Add `--debug` to any
command for `[debug]` traces on stderr.

| Command | What it does | Network |
|---|---|---|
| `sync [--week [DATE]] [--all]` | Incremental courseware sync (current week by default; `--all` = whole term) | online |
| `schedule [--date DATE] [--week [DATE]]` | Timetable for a day / week | cache, fetches when needed |
| `courses [--live]` | Enrolled courses (auto-syncs once if cache is empty) | cache, or live with `--live` |
| `course --code CODE` | One course: assignments, quizzes, materials, announcements | online |
| `assign --url URL` / `--code CODE [--name TEXT]` | One assignment: description, status, attachments | online |
| `post --url URL` / `--code CODE [--name TEXT]` | One announcement's full body | online |
| `forum --url URL` / `--code CODE [--bodies]` | Every thread in every forum (optionally with bodies) | online |
| `links --code CODE` | Every activity/resource link in a course | online |
| `get --url URL [--out DIR]` | Download one Moodle file through the logged-in session | online |
| `pending [--course CODE]` | Upcoming Moodle deadlines | online |
| `files [--course CODE] [--date DATE] [--recent [--n N]]` | Query downloaded files | cache |
| `notes [--course CODE] [--dry-run] [--force] [--limit N]` | Generate Obsidian review notes | online (LLM) |
| `status` | Sync state overview | cache |
| `--version`, `--help` | Version / usage | — |

`files --course CODE --date DATE` returns files uploaded between the previous
class and `DATE` — useful for prepping one specific lecture.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MUSTER_USERNAME` | yes* | — | M.U.S.T. portal username |
| `MUSTER_PASSWORD` | yes* | — | M.U.S.T. portal password |
| `MUSTER_DOWNLOAD_PATH` | no | `~/.must-bee` | Download/state root (files land in `<root>/wemust/`) |
| `MUSTER_NO_SANDBOX` | no | `0` | Set to `1` only if Chromium cannot start with its sandbox (e.g. root in a container) |
| `MUSTER_MAX_DOWNLOAD_MB` | no | `200` | Per-file cap for external announcement links |
| `MUSTER_PYTHON` | no | `python3` | Python used by `notes` |
| `DEEPSEEK_API_KEY` | for `notes` | — | API key for note generation |
| `DEEPSEEK_API_BASE` | no | `https://api.deepseek.com` | Any DeepSeek-compatible endpoint |
| `DEEPSEEK_MODEL` | no | `deepseek-chat` | Model used for notes |
| `OBSIDIAN_VAULT_PATH` | for `notes` | first existing of `~/Vaults/Obsidian`, `~/Obsidian` | Vault root; notes go to `Courses/<course> <code>/` |
| `MUST_BEE_ENV` | no | — | Extra `.env` file to load in `notes` |

\* Cache-only commands (`status`, `files` without `--date`) work without
credentials. Everything that talks to Moodle needs them.

`notes` also needs Python packages:

```bash
python3 -m pip install -r requirements-notes.txt
```

## Security & privacy

- **Credentials stay local.** They are read from the environment (or `.env`) and
  typed into the M.U.S.T. login page only. must-bee has no telemetry, no remote
  logging, and never writes credentials to disk. `.env` is gitignored.
- **Chromium sandbox is on by default.** `MUSTER_NO_SANDBOX=1` is an explicit
  opt-out for environments where the sandbox cannot work.
- **Bounded downloads.** External announcement links are capped at 200 MB;
  zip extraction is capped at 500 entries, 100 MB per file and 300 MB total
  (defends against zip bombs / decompression DoS).
- **`get` is not an open proxy.** It only accepts `*.must.edu.mo` URLs.
- **LLM privacy.** `notes` sends extracted courseware text to the configured
  DeepSeek-compatible API. If your course material is confidential, do not run
  `notes` (or point `DEEPSEEK_API_BASE` at a local endpoint).
- See [SECURITY.md](./SECURITY.md) for the threat model and how to report issues.

## Requirements

- Node.js ≥ 18
- Chromium via `npx playwright install chromium`
- Python 3.9+ (only for `notes`)

## How it works

- Playwright drives a headless Chromium through the M.U.S.T. CAS login.
- Moodle pages are read through the authenticated browser context; the CLI does
  not reimplement Moodle's web service API.
- The timetable SPA signs its own requests, so must-bee hooks `XMLHttpRequest`
  and reads the responses the page already receives instead of reverse
  engineering the signature.
- Everything is emitted as JSON: one value on stdout, errors as
  `{"error": "...", "partialReport"?: {...}}` on stderr with a non-zero exit.

Per-command output shapes are documented in [SKILL.md](./SKILL.md#output-shapes).

## Credits

must-bee is a fork of [Cosmostima/muster_skill](https://github.com/Cosmostima/muster_skill)
(MIT). Original copyright © 2026 Cosmostima. This fork adds timetable capture,
announcement/forum scanning, external courseware download, assignment/post
inspection, Obsidian note generation, and extensive hardening.

## License

[MIT](./LICENSE)
