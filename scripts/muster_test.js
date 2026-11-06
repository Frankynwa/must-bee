#!/usr/bin/env node
'use strict';

/**
 * Unit tests for must-bee.
 *
 * These import the real modules (scripts/lib/core.js, scripts/lib/net.js) —
 * not copies — so a regression in the shipped code fails the suite.
 *
 * Run:  npm test
 * No browser / network required.
 */

const AdmZip = require('adm-zip');
const core = require('./lib/core');
const net = require('./lib/net');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

function group(name) {
  console.log(`\n${name}`);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};
const assertEqual = (actual, expected, msg) => {
  if (actual !== expected) {
    throw new Error(msg || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// ── core: dates & formatting ─────────────────────────────────────────────────

group('macauDateOffset');
test('offset=0 returns today in YYYY-MM-DD', () => {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(core.macauDateOffset(0)));
});
test('offset=1 is after today', () => {
  assert(core.macauDateOffset(1) > core.macauDateOffset(0));
});
test('offset=-1 is before today', () => {
  assert(core.macauDateOffset(-1) < core.macauDateOffset(0));
});

group('validateDate');
test('valid date passes', () => core.validateDate('2026-03-19'));
test('invalid format throws', () => {
  let threw = false;
  try { core.validateDate('26-3-19'); } catch { threw = true; }
  assert(threw);
});
test('non-date string throws', () => {
  let threw = false;
  try { core.validateDate('not-a-date'); } catch { threw = true; }
  assert(threw);
});

group('normalizeText');
test('collapses whitespace', () => assertEqual(core.normalizeText('  hello   world  '), 'hello world'));
test('handles null/undefined', () => {
  assertEqual(core.normalizeText(null), '');
  assertEqual(core.normalizeText(undefined), '');
});
test('trims tabs and newlines', () => assertEqual(core.normalizeText('\t foo\n bar\t'), 'foo bar'));

// ── core: URLs & filenames ───────────────────────────────────────────────────

group('normalizeFileUrl');
test('strips forcedownload param', () => {
  const result = core.normalizeFileUrl('https://moodle.must.edu.mo/mod/resource/view.php?id=123&forcedownload=1');
  assert(!result.includes('forcedownload'), result);
  assert(result.includes('id=123'), result);
});
test('strips token param', () => {
  const result = core.normalizeFileUrl('https://moodle.must.edu.mo/mod/resource/view.php?id=5&token=abc123');
  assert(!result.includes('token'), result);
});
test('keeps non-transient params', () => {
  const result = core.normalizeFileUrl('https://moodle.must.edu.mo/mod/resource/view.php?id=99&revision=3');
  assert(result.includes('revision=3'), result);
});
test('pluginfile.php strips all params', () => {
  const result = core.normalizeFileUrl('https://moodle.must.edu.mo/pluginfile.php/123/mod_resource/content/0/file.pdf?revision=2&forcedownload=1');
  assert(!result.includes('?'), `unexpected query: ${result}`);
});
test('relative url resolved against MOODLE_URL', () => {
  const result = core.normalizeFileUrl('/mod/resource/view.php?id=42');
  assert(result.startsWith('https://moodle.must.edu.mo'), result);
});
test('non-url string resolved relative to MOODLE_URL', () => {
  const result = core.normalizeFileUrl('some/relative/path?token=x&id=5');
  assert(result.startsWith('https://moodle.must.edu.mo'), result);
  assert(!result.includes('token='), result);
});
test('non-http protocol is returned untouched', () => {
  assertEqual(core.normalizeFileUrl('javascript:alert(1)'), 'javascript:alert(1)');
});

group('safeFilename');
test('strips forbidden characters', () => {
  const result = core.safeFilename('foo/bar:baz*qux?.txt');
  assert(!/[\\/:*?"<>|]/.test(result), result);
});
test('blocks path traversal', () => {
  const result = core.safeFilename('../../etc/passwd');
  assert(!result.includes('/') && !result.includes('\\'), result);
  assert(!result.startsWith('.'), result);
});
test('strips leading dots (no hidden files)', () => {
  assertEqual(core.safeFilename('.env'), 'env');
});
test('neutralizes Windows reserved names', () => {
  assert(core.safeFilename('CON.txt').startsWith('_'), core.safeFilename('CON.txt'));
});
test('truncates to 240 chars but keeps the extension', () => {
  const result = core.safeFilename('a'.repeat(300) + '.pdf');
  assert(result.length <= core.MAX_FILENAME_LENGTH, String(result.length));
  assert(result.endsWith('.pdf'), result);
});
test('empty input falls back to file', () => assertEqual(core.safeFilename('   '), 'file'));
test('safe name unchanged', () => assertEqual(core.safeFilename('lecture_01.pdf'), 'lecture_01.pdf'));

group('fingerprint');
test('same inputs produce same hash', () => {
  assertEqual(
    core.fingerprint('http://a', 'http://b', 'file.pdf'),
    core.fingerprint('http://a', 'http://b', 'file.pdf')
  );
});
test('different filename produces different hash', () => {
  assert(core.fingerprint('http://a', 'http://b', 'file.pdf') !== core.fingerprint('http://a', 'http://b', 'other.pdf'));
});
test('hash is 64-char hex', () => {
  assert(/^[0-9a-f]{64}$/.test(core.fingerprint('a', 'b', 'c')));
});

group('compactError');
test('takes first line of multiline error', () => {
  assertEqual(core.compactError(new Error('line one\nline two')), 'line one');
});
test('truncates at 400 chars', () => {
  assert(core.compactError(new Error('x'.repeat(500))).length <= 400);
});
test('handles string error', () => assertEqual(core.compactError('oops'), 'oops'));

group('courseDirName');
test('with courseCode: code-name', () => assertEqual(core.courseDirName('CS360', 'Networks'), 'CS360-Networks'));
test('without courseCode: name only', () => {
  assertEqual(core.courseDirName('', 'Networks'), 'Networks');
  assertEqual(core.courseDirName(null, 'Networks'), 'Networks');
});
test('sanitizes forbidden chars', () => {
  const result = core.courseDirName('CS/360', 'Net:works');
  assert(!/[\\/:*?"<>|]/.test(result), result);
});

group('deriveCourseCode');
test('extracts code from a term-prefixed name', () => {
  assertEqual(core.deriveCourseCode('2609-CS482EX1-5A7EE7'), 'CS482');
  assertEqual(core.deriveCourseCode('2609-EIE470EX1-173EA3'), 'EIE470');
  assertEqual(core.deriveCourseCode('2609-BE301EX1-3F171E'), 'BE301');
});
test('extracts code from a plain title', () => {
  assertEqual(core.deriveCourseCode('CS482 數據科學'), 'CS482');
});
test('does not confuse a longer number with the code', () => {
  assertEqual(core.deriveCourseCode('2609-CS4820EX1-AAAAAA'), '');
});
test('returns empty for names without a code', () => {
  assertEqual(core.deriveCourseCode('數據科學'), '');
  assertEqual(core.deriveCourseCode(''), '');
});

// ── core: timetable ─────────────────────────────────────────────────────────

group('weekBounds');
test('Monday returns itself as mondayStr', () => {
  assertEqual(core.weekBounds('2026-03-16').mondayStr, '2026-03-16');
});
test('Sunday returns itself as sundayStr', () => {
  assertEqual(core.weekBounds('2026-03-22').sundayStr, '2026-03-22');
});
test('Wednesday in week → correct Monday/Sunday', () => {
  const { mondayStr, sundayStr } = core.weekBounds('2026-03-18');
  assertEqual(mondayStr, '2026-03-16');
  assertEqual(sundayStr, '2026-03-22');
});
test('Saturday → correct week bounds', () => {
  const { mondayStr, sundayStr } = core.weekBounds('2026-03-21');
  assertEqual(mondayStr, '2026-03-16');
  assertEqual(sundayStr, '2026-03-22');
});

group('weekKey');
test('formats as mon_sun', () => assertEqual(core.weekKey('2026-03-16', '2026-03-22'), '2026-03-16_2026-03-22'));

group('isWeekStale');
test('null entry is stale', () => assert(core.isWeekStale(null, '2026-03-16', '2026-03-22')));
test('missing fetchedAt is stale', () => assert(core.isWeekStale({}, '2026-03-16', '2026-03-22')));
test('past week is never stale', () => {
  const past = { fetchedAt: new Date(Date.now() - 999 * 86400000).toISOString() };
  assert(!core.isWeekStale(past, '2020-01-06', '2020-01-12'));
});
test('current week fresh entry not stale', () => {
  const { mondayStr, sundayStr } = core.weekBounds(core.macauDateOffset(0));
  assert(!core.isWeekStale({ fetchedAt: new Date().toISOString() }, mondayStr, sundayStr));
});
test('current week old entry is stale', () => {
  const { mondayStr, sundayStr } = core.weekBounds(core.macauDateOffset(0));
  const old = { fetchedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString() };
  assert(core.isWeekStale(old, mondayStr, sundayStr));
});

group('getLessonDatesForCourse');
test('returns sorted dates for matching courseCode', () => {
  const tt = {
    weeks: {
      w1: { lessons: [
        { courseCode: 'CS360', lessonDate: '2026-03-19' },
        { courseCode: 'CS370', lessonDate: '2026-03-20' },
      ] },
      w2: { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-12' }] },
    }
  };
  assertEqual(JSON.stringify(core.getLessonDatesForCourse(tt, 'CS360')), JSON.stringify(['2026-03-12', '2026-03-19']));
});
test('returns empty for unknown course', () => {
  const tt = { weeks: { w1: { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] } } };
  assertEqual(core.getLessonDatesForCourse(tt, 'CS999').length, 0);
});
test('deduplicates dates', () => {
  const tt = {
    weeks: {
      w1: { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] },
      w2: { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] },
    }
  };
  assertEqual(core.getLessonDatesForCourse(tt, 'CS360').length, 1);
});
test('handles a state object without weeks', () => {
  assertEqual(core.getLessonDatesForCourse({}, 'CS360').length, 0);
});

group('extractModId');
test('extracts id from resource url', () => {
  assertEqual(core.extractModId('https://moodle.must.edu.mo/mod/resource/view.php?id=12345'), 12345);
});
test('extracts id from relative url', () => assertEqual(core.extractModId('/mod/quiz/view.php?id=999'), 999));
test('returns null for non-mod url', () => {
  assert(core.extractModId('https://moodle.must.edu.mo/course/view.php?id=1') === null);
});
test('returns null for invalid url', () => assert(core.extractModId('not a url') === null));

group('unixToDate');
test('epoch 0 → 1970-01-01', () => assertEqual(core.unixToDate(0), '1970-01-01'));
test('known timestamp', () => {
  const ts = Math.floor(new Date('2026-03-19T00:00:00Z').getTime() / 1000);
  assertEqual(core.unixToDate(ts), '2026-03-19');
});
test('pads month and day', () => assertEqual(core.unixToDate(86400), '1970-01-02'));
test('uses Asia/Macau, not UTC (late upload stays on the local day)', () => {
  const ts = Math.floor(new Date('2026-03-18T17:00:00Z').getTime() / 1000); // 01:00 Macau
  assertEqual(core.unixToDate(ts), '2026-03-19');
});

// ── core: course matching ───────────────────────────────────────────────────

group('scoreCourseMatch');
test('exact match → 100', () => assertEqual(core.scoreCourseMatch('cs360', 'cs360'), 100));
test('candidate contains required → 80', () => assertEqual(core.scoreCourseMatch('cs360', '2602-cs360d2'), 80));
test('required contains candidate → 70', () => assertEqual(core.scoreCourseMatch('2602-cs360d2', 'cs360'), 70));
test('no match → 0', () => assertEqual(core.scoreCourseMatch('math101', 'cs999'), 0));
test('token overlap scoring', () => {
  assert(core.scoreCourseMatch('computer networks', 'networks and protocols') >= 10);
});

group('courseMatchesCode');
test('matches a section-suffixed name', () => {
  assert(core.courseMatchesCode('2609-CS482D1-XXXXXX', '', 'CS482'));
});
test('does not match a longer code', () => {
  assert(!core.courseMatchesCode('2609-CS4820D1-XXXXXX', '', 'CS482'));
});
test('CS48 does not match CS482', () => {
  assert(!core.courseMatchesCode('2609-CS482D1-XXXXXX', '', 'CS48'));
});
test('matches a plain course title', () => {
  assert(core.courseMatchesCode('CS482 數據科學', '', 'CS482'));
});

group('matchCourses');
test('matches by courseCode', () => {
  const targets = [{ name: 'Networks', courseCode: 'CS360', enName: '' }];
  const moodle = [
    { name: '2602-CS360D2-XXXXXX', url: 'https://moodle.must.edu.mo/course/view.php?id=1' },
    { name: '2602-CS370D1-YYYYYY', url: 'https://moodle.must.edu.mo/course/view.php?id=2' },
  ];
  const result = core.matchCourses(targets, moodle);
  assertEqual(result.length, 1);
  assertEqual(result[0].courseCode, 'CS360');
  assert(result[0].name.includes('CS360'), result[0].name);
});
test('matches by name token when no courseCode', () => {
  const targets = [{ name: 'Numerical Methods', courseCode: '', enName: '' }];
  const moodle = [{ name: '2602-Numerical Methods-XXXXXX', url: 'https://moodle.must.edu.mo/course/view.php?id=3' }];
  assertEqual(core.matchCourses(targets, moodle).length, 1);
});
test('returns empty if no match above threshold', () => {
  const targets = [{ name: 'Astrophysics 999', courseCode: '', enName: '' }];
  const moodle = [{ name: '2602-CS360D2', url: 'u' }];
  assertEqual(core.matchCourses(targets, moodle).length, 0);
});

// ── core: URLs, CLI, HTTP metadata ──────────────────────────────────────────

group('isMoodleHost');
test('accepts Moodle and subdomains', () => {
  assert(core.isMoodleHost('moodle.must.edu.mo'));
  assert(core.isMoodleHost('classtimetable-coes-wmweb.must.edu.mo'));
  assert(core.isMoodleHost('must.edu.mo'));
});
test('rejects lookalike domains', () => {
  assert(!core.isMoodleHost('moodle.must.edu.mo.evil.com'));
  assert(!core.isMoodleHost('evil-must.edu.mo'));
  assert(!core.isMoodleHost('dropbox.com'));
});

group('isHttpUrl');
test('accepts http(s)', () => {
  assert(core.isHttpUrl('https://x.test/a'));
  assert(core.isHttpUrl('http://x.test/a'));
});
test('rejects other protocols', () => {
  assert(!core.isHttpUrl('javascript:alert(1)'));
  assert(!core.isHttpUrl('file:///etc/passwd'));
});

group('parseCli');
test('parses flags and values', () => {
  const { cmd, options } = core.parseCli(['sync', '--week', '2026-03-13', '--debug']);
  assertEqual(cmd, 'sync');
  assertEqual(options.week, '2026-03-13');
  assertEqual(options.debug, true);
});
test('supports --key=value', () => {
  const { options } = core.parseCli(['files', '--course=CS482', '--n=20']);
  assertEqual(options.course, 'CS482');
  assertEqual(options.n, '20');
});
test('bare flag before another flag is true', () => {
  const { options } = core.parseCli(['sync', '--all', '--debug']);
  assertEqual(options.all, true);
  assertEqual(options.debug, true);
});

group('responseContentLength');
test('prefers content-range total over one-byte body', () => {
  const response = { headers: () => ({ 'content-range': 'bytes 0-0/123456', 'content-length': '1' }) };
  assertEqual(core.responseContentLength(response), 123456);
});
test('falls back to content-length', () => {
  const response = { headers: () => ({ 'content-length': '4096' }) };
  assertEqual(core.responseContentLength(response), 4096);
});
test('returns -1 when unknown', () => {
  assertEqual(core.responseContentLength({ headers: () => ({}) }), -1);
});

group('inferFileNameFromHeaders');
test('decodes RFC 5987 filenames', () => {
  const response = { headers: () => ({ 'content-disposition': "attachment; filename*=UTF-8''%E8%AE%B2%E4%B9%89.pdf" }) };
  assertEqual(core.inferFileNameFromHeaders(response, 'https://x.test/a'), '讲义.pdf');
});
test('falls back to the URL basename', () => {
  assertEqual(core.inferFileNameFromHeaders({ headers: () => ({}) }, 'https://x.test/slides/lec1.pptx'), 'lec1.pptx');
});
test('malformed percent encoding does not throw', () => {
  const response = { headers: () => ({ 'content-disposition': "attachment; filename*=UTF-8''bad%ZZ.pdf" }) };
  assert(typeof core.inferFileNameFromHeaders(response, 'https://x.test/a') === 'string');
});

// ── net: external links & zip safety ────────────────────────────────────────

group('isExternalFileHost');
test('accepts exact hosts and subdomains', () => {
  assert(net.isExternalFileHost('dropbox.com'));
  assert(net.isExternalFileHost('www.dropbox.com'));
  assert(net.isExternalFileHost('drive.google.com'));
});
test('rejects lookalike domains', () => {
  assert(!net.isExternalFileHost('evil-dropbox.com'));
  assert(!net.isExternalFileHost('dropbox.com.evil.com'));
  assert(!net.isExternalFileHost('notgoogle.com'));
});

group('dropboxDirectUrl');
test('changes dl=0 to dl=1', () => {
  const out = net.dropboxDirectUrl('https://www.dropbox.com/s/abc/file.pdf?dl=0');
  assert(out.includes('dl=1'), out);
});
test('adds dl=1 when missing', () => {
  assert(net.dropboxDirectUrl('https://www.dropbox.com/s/abc/file.pdf').includes('dl=1'));
});
test('leaves other hosts alone', () => {
  assertEqual(
    net.dropboxDirectUrl('https://drive.google.com/file/d/abc'),
    'https://drive.google.com/file/d/abc'
  );
});

group('maxDownloadBytes');
test('defaults to 200 MB', () => assertEqual(net.maxDownloadBytes(undefined), 200 * 1024 * 1024));
test('accepts a positive override', () => assertEqual(net.maxDownloadBytes('50'), 50 * 1024 * 1024));
test('ignores nonsense values', () => assertEqual(net.maxDownloadBytes('abc'), 200 * 1024 * 1024));
test('caps at 2 GB', () => assertEqual(net.maxDownloadBytes('99999'), 2048 * 1024 * 1024));

group('extractZipFiles');
test('extracts only PDF/PPT/PPTX entries', () => {
  const zip = new AdmZip();
  zip.addFile('slides/lecture.pdf', Buffer.from('%PDF-1.4'));
  zip.addFile('slides/notes.txt', Buffer.from('ignore me'));
  zip.addFile('deck.pptx', Buffer.from('PK-fake'));
  const result = net.extractZipFiles(zip.toBuffer());
  assert(result.isZip);
  assertEqual(result.files.length, 2);
  assert(result.files.some(f => f.filename === 'lecture.pdf'));
  assert(result.files.some(f => f.filename === 'deck.pptx'));
});
test('strips directory traversal from entry names', () => {
  const zip = new AdmZip();
  zip.addFile('../../escape.pdf', Buffer.from('%PDF-1.4'));
  const result = net.extractZipFiles(zip.toBuffer());
  assertEqual(result.files.length, 1);
  assertEqual(result.files[0].filename, 'escape.pdf');
});
test('non-zip buffer is not treated as an archive', () => {
  const result = net.extractZipFiles(Buffer.from('not a zip'));
  assertEqual(result.isZip, false);
  assertEqual(result.files.length, 0);
});
test('malformed zip returns empty files instead of throwing', () => {
  const result = net.extractZipFiles(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  assert(result.isZip);
  assertEqual(result.files.length, 0);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
