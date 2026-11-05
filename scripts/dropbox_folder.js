// List a Dropbox shared-folder link by downloading it as a zip, using a direct
// DNS resolver (bypasses the local mDNSResponder/CDN stall on some networks).
const dns = require('dns');
const https = require('https');
const fs = require('fs');

const RAW = process.argv[2];
const OUT = process.argv[3] || '/tmp/dropbox_folder.zip';

const resolver = new dns.Resolver({ timeout: 8000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8', '223.5.5.5']);

function resolve4(host) {
  return new Promise((resolve) => {
    resolver.resolve4(host, (err, addrs) => {
      if (err || !addrs || !addrs.length) resolve(null);
      else resolve(addrs);
    });
  });
}

function get(url, redirects = 6) {
  return new Promise(async (resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const addrs = await resolve4(u.hostname);
    const ip = addrs && addrs[0];
    const opts = {
      host: ip || u.hostname,
      servername: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Host: u.hostname,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
      }
    };
    if (ip) opts.lookup = (host, o, cb) => cb(null, ip, 4);
    const req = https.request(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const url = RAW.replace('dl=0', 'dl=1');
  const res = await get(url);
  const ct = res.headers['content-type'] || '';
  const cd = res.headers['content-disposition'] || '';
  console.error('content-type:', ct);
  console.error('content-disposition:', cd);
  const out = fs.createWriteStream(OUT);
  res.pipe(out);
  out.on('finish', () => {
    const sz = fs.statSync(OUT).size;
    console.log(JSON.stringify({ saved: OUT, bytes: sz, contentType: ct, disposition: cd }));
  });
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
