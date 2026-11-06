'use strict';

/**
 * Network helpers for external courseware links (Dropbox / Drive / ...).
 *
 * Kept separate from the CLI so it can be unit-tested without a browser.
 * All downloads are bounded: a malicious or accidental multi-GB share link
 * must not be able to exhaust memory.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const path = require('path');
const AdmZip = require('adm-zip');
const { safeFilename, FILE_EXT_RE } = require('./core');

// Hosts whose links are accepted from Moodle announcements. Matching is done
// on label boundaries (evil-dropbox.com must NOT match dropbox.com).
const EXTERNAL_FILE_HOSTS = [
  'dropbox.com',
  'dropboxusercontent.com',
  'drive.google.com',
  'docs.google.com',
  'onedrive.live.com',
  '1drv.ms',
  'mega.nz',
  'we.tl'
];

const DEFAULT_MAX_DOWNLOAD_MB = 200;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;   // 100 MB per extracted file
const MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024;   // 300 MB extracted in total

function maxDownloadBytes(value = process.env.MUSTER_MAX_DOWNLOAD_MB) {
  const mb = Number(value);
  const safe = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 2048) : DEFAULT_MAX_DOWNLOAD_MB;
  return Math.floor(safe * 1024 * 1024);
}

function isExternalFileHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return EXTERNAL_FILE_HOSTS.some(domain => h === domain || h.endsWith(`.${domain}`));
}

function dropboxDirectUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') {
      if (u.searchParams.get('dl') === '0' || !u.searchParams.has('dl')) {
        u.searchParams.set('dl', '1');
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

// DNS resolver that bypasses the OS resolver (mDNSResponder can stall on some
// CDN names like dropbox.com on campus networks). Uses direct DNS queries and
// supports Node's happy-eyeballs lookup (opts.all → return address array).
function resolve4WithTimeout(hostname, ms = 8000) {
  return new Promise((resolve, reject) => {
    const r = new dns.Resolver();
    const timer = setTimeout(() => {
      r.cancel();
      reject(new Error(`DNS timeout for ${hostname}`));
    }, ms);
    r.resolve4(hostname, (err, addrs) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addrs);
    });
  });
}

function dnsResolver() {
  const cache = new Map();
  return (hostname, opts, cb) => {
    const wantAll = !!(opts && opts.all);
    const done = (err, addrs) => {
      if (err) { cb(err); return; }
      if (wantAll) cb(null, addrs);
      else if (addrs && addrs.length) cb(null, addrs[0].address, addrs[0].family);
      else cb(new Error(`no address for ${hostname}`));
    };
    if (cache.has(hostname)) {
      process.nextTick(() => done(null, cache.get(hostname)));
      return;
    }
    resolve4WithTimeout(hostname).then((ips) => {
      const addrs = ips.map((ip) => ({ address: ip, family: 4 }));
      cache.set(hostname, addrs);
      done(null, addrs);
    }).catch((err) => {
      const e = new Error(`DNS resolve failed for ${hostname}: ${err && (err.code || err.message)}`);
      e.code = err && err.code;
      cb(e);
    });
  };
}

function httpGetExternal(url, redirectsLeft = 5, limitBytes = maxDownloadBytes()) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol: ${target.protocol}`));
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, {
      lookup: dnsResolver(),
      headers: { 'User-Agent': 'must-bee/2.1 (courseware sync)' }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, target);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          reject(new Error(`Unsupported redirect protocol: ${next.protocol}`));
          return;
        }
        resolve(httpGetExternal(next.toString(), redirectsLeft - 1, limitBytes));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${target.hostname}${target.pathname}`));
        return;
      }

      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > limitBytes) {
        res.destroy();
        reject(new Error(`File too large (${declared} bytes > ${limitBytes} byte limit)`));
        return;
      }

      const chunks = [];
      let received = 0;
      res.on('data', (c) => {
        received += c.length;
        if (received > limitBytes) {
          res.destroy(new Error(`File too large (> ${limitBytes} byte limit)`));
          return;
        }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => resolve({
        url: target.toString(),
        buffer: Buffer.concat(chunks),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

function isZipBuffer(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * Extract PDF/PPT/PPTX entries from a zip archive (e.g. a shared Dropbox
 * folder downloaded as zip). Returns { isZip, files: [{filename, buffer}] }.
 *
 * Bounded against zip bombs: entry count, declared uncompressed size per entry,
 * total extracted bytes, and zero-sized entries (a known adm-zip bypass).
 */
function extractZipFiles(buffer) {
  if (!isZipBuffer(buffer)) return { isZip: false, files: [] };
  const out = [];
  let total = 0;
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = safeFilename(path.basename(entry.entryName));
      if (!FILE_EXT_RE.test(name)) continue;

      const declared = Number(entry.header && entry.header.size);
      if (!Number.isFinite(declared) || declared <= 0) continue;
      if (declared > MAX_ZIP_ENTRY_BYTES) continue;
      if (total + declared > MAX_ZIP_TOTAL_BYTES) break;
      if (out.length >= MAX_ZIP_ENTRIES) break;

      let data;
      try {
        data = entry.getData();
      } catch {
        continue; // encrypted/corrupt entry — skip it, keep the rest
      }
      if (!data || data.length > MAX_ZIP_ENTRY_BYTES || total + data.length > MAX_ZIP_TOTAL_BYTES) {
        continue;
      }
      total += data.length;
      out.push({ filename: name, buffer: data });
    }
    return { isZip: true, files: out };
  } catch {
    return { isZip: true, files: [] };
  }
}

module.exports = {
  EXTERNAL_FILE_HOSTS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
  maxDownloadBytes,
  isExternalFileHost,
  dropboxDirectUrl,
  resolve4WithTimeout,
  dnsResolver,
  httpGetExternal,
  isZipBuffer,
  extractZipFiles
};
