# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 2.x | ✅ |
| 0.x / 1.x | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/Frankynwa/must-bee/security/advisories/new)

Include:

- affected version or commit
- a minimal reproduction (command, input, expected vs actual)
- impact assessment (credential exposure, arbitrary file write, DoS, …)
- whether the issue requires a malicious Moodle page, a malicious external
  link, or only local access

You can expect an acknowledgement within 48 hours and a fix or mitigation
within 7 days for confirmed issues. Please give us a reasonable window before
public disclosure.

**Never include real credentials, cookies, or student data in a report.**
Redact them from logs.

## Threat model

must-bee is a local CLI that drives a headless browser with the user's own
M.U.S.T. session. The assets worth protecting are:

1. **M.U.S.T. credentials** (`MUSTER_USERNAME` / `MUSTER_PASSWORD`)
2. **The authenticated Moodle session** (cookies inside Playwright's context)
3. **Local files** (courseware and generated notes)

Relevant attackers and inputs:

- **Untrusted remote content.** Moodle pages and announcement links are
  attacker-influenced if a course forum is compromised. must-bee treats file
  names, `Content-Disposition` values, zip entry names, and HTML text as
  untrusted: names are sanitized to a single path component, zip entries are
  extracted by basename only, and external downloads/extraction are bounded.
- **Malicious external links.** Announcement links are accepted only for a
  fixed host allowlist (Dropbox, Google Drive/Docs, OneDrive, 1drv.ms, MEGA,
  WeTransfer) matched on domain-label boundaries.
- **Network attackers.** Traffic goes through Chromium's normal TLS validation;
  no certificate pinning or custom trust store is used.

Out of scope:

- University acceptable-use policy or terms of service.
- A compromised local machine (malware can read environment variables and
  browser profiles regardless of must-bee).
- Local tampering with `.muster.json` or downloaded files by the same user.
- Rate limits or account lockout caused by aggressive syncing.

## Security defaults

- Credentials are read from the environment / `.env` (gitignored) and typed
  only into the M.U.S.T. login form. They are never written to disk, logged, or
  sent anywhere else.
- Chromium runs with its sandbox enabled. `MUSTER_NO_SANDBOX=1` is an explicit
  opt-out for containers/root environments.
- `get` refuses non-`*.must.edu.mo` URLs so the authenticated session cannot be
  used as a general-purpose proxy.
- External announcement downloads are capped at 200 MB
  (`MUSTER_MAX_DOWNLOAD_MB`); zip extraction is capped at 500 entries, 100 MB
  per entry and 300 MB total.
- `notes` sends extracted courseware text to the configured LLM endpoint. This
  is documented in the README; users handling confidential material should not
  run it or should point `DEEPSEEK_API_BASE` at a local service.
- The Python child process used by `notes` receives only the environment
  variables it needs — not `MUSTER_PASSWORD`.
