# Contributing to must-bee

Thanks for helping. This is a small, security-sensitive CLI: please keep
changes focused and easy to review.

## Setup

```bash
git clone https://github.com/Frankynwa/must-bee.git
cd must-bee
npm install
npx playwright install chromium

cp .env.example .env     # fill in test credentials locally; never commit it
npm test                 # 96 unit tests, no network
npm run check            # syntax checks for JS + Python
```

## Architecture

| Path | Responsibility |
|---|---|
| `scripts/muster_cli.js` | CLI entry, Playwright commands, sync pipeline |
| `scripts/lib/core.js` | Pure helpers (dates, filenames, URLs, matching, CLI parsing) |
| `scripts/lib/net.js` | External links, DNS workaround, bounded HTTP + zip extraction |
| `scripts/notes.py` | Courseware → Obsidian notes (PyMuPDF / python-pptx / DeepSeek) |
| `scripts/muster_test.js` | Unit tests; imports the real modules |

Keep pure logic in `lib/` so it can be tested without a browser or network.
Command functions may use Playwright, but should not duplicate helpers that
belong in `lib/`.

## Rules

- **Never commit credentials, cookies, `.muster.json` state, or downloaded
  courseware.** `.env` is gitignored for a reason.
- **Treat remote content as untrusted.** Any new file name, zip entry, URL or
  HTML-derived path must go through `safeFilename`, `normalizeFileUrl`, or an
  explicit allowlist. Add a test.
- **Bound new downloads.** Do not add an unbounded `Buffer.concat` or zip
  extraction path. Reuse `httpGetExternal` / `extractZipFiles`.
- **Keep stdout machine-readable.** One JSON value on stdout; diagnostics go to
  stderr behind `--debug`.
- **Do not break output shapes.** They are documented in `SKILL.md`; agents
  depend on them. Add fields rather than renaming existing ones.

## Tests

- Add a test to `scripts/muster_test.js` for every new pure helper or bug fix.
- Tests must not require credentials, a browser, or the network. Use local
  fixtures (e.g. an `AdmZip` buffer) instead.
- Run `npm test && npm run check` before opening a PR.

## Commits and PRs

- Use Conventional Commits: `feat(scope): ...`, `fix(scope): ...`,
  `docs: ...`, `test: ...`, `chore: ...`.
- One logical change per commit.
- In the PR description, say what changed, why, and how you tested it.
- Security fixes: describe the impact without publishing an exploit before a
  release; see [SECURITY.md](./SECURITY.md).

## Code style

- CommonJS, Node.js ≥ 18, 2-space indentation.
- Prefer small functions with explicit error handling over broad `try/catch`.
- No new runtime dependencies unless they are necessary; justify them in the PR.
