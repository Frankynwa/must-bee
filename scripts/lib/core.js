'use strict';

/**
 * Pure helpers shared by the CLI and the test suite.
 *
 * Nothing in this module touches the network, the filesystem or Playwright, so
 * it can be imported by unit tests without starting the CLI.
 */

const crypto = require('crypto');
const path = require('path');

const TZ = 'Asia/Macau';
const MOODLE_URL = 'https://moodle.must.edu.mo/';
const MOODLE_HOST = 'moodle.must.edu.mo';
const MUST_DOMAIN = 'must.edu.mo';

const TRANSIENT_QUERY_PARAMS = new Set([
  'token', 'forcedownload', 'download', 'time', 'expires', 'signature',
  'sesskey', 'redirect', 'cache', 't', '_'
]);

const FILE_EXT_RE = /\.(pdf|ppt|pptx)$/i;

// Staleness thresholds for timetable weeks.
const STALE_CURRENT_MS = 6 * 3600 * 1000;   // current week: 6 hours
const STALE_FUTURE_MS = 24 * 3600 * 1000;   // future weeks: 24 hours
// Past weeks: never stale

const MAX_FILENAME_LENGTH = 240;

function isoNow() {
  return new Date().toISOString();
}

function macauDateOffset(days) {
  const base = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(base);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error(`Invalid date '${date}'. Expected YYYY-MM-DD.`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeFileUrl(rawUrl, base = MOODLE_URL) {
  try {
    const resolved = new URL(rawUrl, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return rawUrl;
    const out = new URL(`${resolved.origin}${resolved.pathname}`);
    const kept = new URLSearchParams();
    for (const [key, value] of resolved.searchParams.entries()) {
      if (!TRANSIENT_QUERY_PARAMS.has(key.toLowerCase())) {
        kept.append(key, value);
      }
    }
    const sorted = [...kept.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sorted.length > 0 && !resolved.pathname.includes('pluginfile.php')) {
      out.search = new URLSearchParams(sorted).toString();
    }
    return out.toString();
  } catch {
    return rawUrl;
  }
}

function fingerprint(courseUrl, normalizedFileUrl, filename) {
  const payload = `${courseUrl}|${normalizedFileUrl}|${filename}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Turn untrusted text (Content-Disposition, page titles, zip entry names) into
 * a single safe path component. Also avoids reserved Windows device names and
 * hidden dot-files so a synced folder stays portable.
 */
function safeFilename(name) {
  let out = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  if (out.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(out).slice(0, 16);
    out = out.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  if (!out) out = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) out = `_${out}`;
  return out;
}

function compactError(err) {
  const text = String(err && (err.message || err) ? err.message || err : err || '');
  const first = text.split('\n')[0];
  return first.slice(0, 400);
}

function courseDirName(courseCode, courseName) {
  const raw = courseCode ? `${courseCode}-${courseName}` : courseName;
  return safeFilename(raw || 'course');
}

/**
 * Moodle course names look like "2609-CS482EX1-5A7EE7" or "2602-CS360D2-XXXXXX".
 * Recover the actual course code (CS482 / CS360) so cache lookups by code work
 * even when a live dashboard scan did not supply one.
 */
function deriveCourseCode(courseName) {
  const text = String(courseName || '').toUpperCase();
  const termPrefixed = text.match(/^\d{4}-([A-Z]{2,4}\d{3})(?![0-9])/);
  if (termPrefixed) return termPrefixed[1];
  const generic = text.match(/(?:^|[^A-Z0-9])([A-Z]{2,4}\d{3})(?![0-9])/);
  return generic ? generic[1] : '';
}

function weekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  const dow = d.getDay() || 7; // 1=Mon … 7=Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = x => x.toISOString().slice(0, 10);
  return { mondayStr: fmt(monday), sundayStr: fmt(sunday) };
}

function weekKey(mondayStr, sundayStr) {
  return `${mondayStr}_${sundayStr}`;
}

function isWeekStale(entry, mondayStr, sundayStr) {
  if (!entry || !entry.fetchedAt) return true;
  const todayStr = macauDateOffset(0);
  if (sundayStr < todayStr) return false; // past week: immutable
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  if (mondayStr <= todayStr) return ageMs > STALE_CURRENT_MS;
  return ageMs > STALE_FUTURE_MS;
}

function getLessonDatesForCourse(ttState, courseCode) {
  const dates = new Set();
  for (const entry of Object.values(ttState.weeks || {})) {
    for (const l of (entry.lessons || [])) {
      if (l.courseCode === courseCode) dates.add(l.lessonDate);
    }
  }
  return [...dates].sort();
}

function extractModId(resourceUrl) {
  try {
    const u = new URL(resourceUrl, MOODLE_URL);
    if (u.pathname.includes('/mod/') && u.searchParams.has('id')) {
      return Number(u.searchParams.get('id')) || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Moodle stores timestamps in UTC, but students think in Asia/Macau dates.
 * Formatting in UTC shifts late-night uploads to the previous day.
 */
function unixToDate(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  return `${parts.find(p => p.type === 'year').value}-`
    + `${parts.find(p => p.type === 'month').value}-`
    + `${parts.find(p => p.type === 'day').value}`;
}

function scoreCourseMatch(required, candidate) {
  const a = String(required || '').toLowerCase();
  const b = String(candidate || '').toLowerCase();
  if (a === b) return 100;
  if (b.includes(a)) return 80;
  if (a.includes(b)) return 70;

  const aTokens = new Set(a.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean));
  const bTokens = new Set(b.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean));
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap += 1;
  return overlap * 10;
}

function courseMatchesCode(courseName, courseUrl, code) {
  const needle = String(code || '').toUpperCase();
  if (!needle) return false;
  const name = String(courseName || '').toUpperCase();
  const url = String(courseUrl || '').toUpperCase();
  // Require a boundary before the code and no digit immediately after it, so
  // CS48 does not match CS482 — while still allowing section suffixes such as
  // "2609-CS482D1".
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}(?![0-9])`).test(name) || url.includes(needle);
}

function matchCourses(targetCourses, moodleCourses) {
  const out = [];
  for (const target of targetCourses) {
    if (target.courseCode) {
      const byCode = moodleCourses.find(
        mc => courseMatchesCode(mc.name, mc.url, target.courseCode)
      );
      if (byCode) {
        out.push({ requestedName: target.name, courseCode: target.courseCode, ...byCode });
        continue;
      }
    }
    const candidates = [target.name, target.enName].filter(Boolean);
    let best = null;
    for (const name of candidates) {
      const ranked = moodleCourses
        .map((mc) => ({ course: mc, score: scoreCourseMatch(name, mc.name) }))
        .sort((x, y) => y.score - x.score);
      if (ranked.length && ranked[0].score >= 20) {
        if (!best || ranked[0].score > best.score) best = ranked[0];
      }
    }
    if (best) {
      out.push({ requestedName: target.name, courseCode: target.courseCode, ...best.course });
    }
  }
  return out;
}

function isMoodleHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return h === MOODLE_HOST || h === MUST_DOMAIN || h.endsWith(`.${MUST_DOMAIN}`);
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCli(argv) {
  const [cmd, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--') || token === '--') continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      options[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? rest[++i] : true;
    options[key] = value;
  }
  return { cmd, options };
}

function responseContentLength(response) {
  const headers = response.headers();
  // HEAD may be unsupported; the GET Range fallback replies 206 with
  // `content-range: bytes 0-0/<total>`. Use the declared total, not the
  // one-byte body length.
  const range = String(headers['content-range'] || '');
  const totalMatch = range.match(/\/(\d+)\s*$/);
  if (totalMatch) return Number(totalMatch[1]);
  const len = Number(headers['content-length']);
  if (Number.isFinite(len) && len >= 0) return len;
  return -1;
}

function inferFileNameFromHeaders(response, fallbackUrl) {
  const cd = response.headers()['content-disposition'] || '';
  const utf = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf && utf[1]) {
    try { return decodeURIComponent(utf[1]); } catch { return utf[1]; }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return plain[1];

  try {
    const u = new URL(fallbackUrl);
    const basename = path.basename(u.pathname);
    return basename || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

module.exports = {
  TZ,
  MOODLE_URL,
  MOODLE_HOST,
  MUST_DOMAIN,
  TRANSIENT_QUERY_PARAMS,
  FILE_EXT_RE,
  STALE_CURRENT_MS,
  STALE_FUTURE_MS,
  MAX_FILENAME_LENGTH,
  isoNow,
  macauDateOffset,
  validateDate,
  normalizeText,
  normalizeFileUrl,
  fingerprint,
  safeFilename,
  compactError,
  courseDirName,
  deriveCourseCode,
  weekBounds,
  weekKey,
  isWeekStale,
  getLessonDatesForCourse,
  extractModId,
  unixToDate,
  scoreCourseMatch,
  courseMatchesCode,
  matchCourses,
  isMoodleHost,
  isHttpUrl,
  parseCli,
  responseContentLength,
  inferFileNameFromHeaders
};
