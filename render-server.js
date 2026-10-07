const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

process.env.RENDER = '1';

const uploadHandler = require('./api/upload.js');
const analyzeHandler = require('./api/analyze.js');
const jobsHandler = require('./api/jobs/[id].js');

const PORT = Number(process.env.PORT || 10000);
const SANDBOX_BASE = process.env.CLIP_SANDBOX_DIR || '/tmp/clipping-sandboxes';
const MAX = 900 * 1024 * 1024;

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function adapt(req, res, body, query) {
  return {
    req: Object.assign(req, { body, query }),
    res: {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(n) { this.statusCode = n; return this; },
      json(obj) {
        const payload = Buffer.from(JSON.stringify(obj));
        if (!res.headersSent) res.writeHead(this.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', ...this._headers });
        res.end(payload);
      },
      end(body = '') {
        if (!res.headersSent) res.writeHead(this.statusCode || 200, this._headers);
        res.end(body);
      }
    }
  };
}

async function handleUploadFile(req, res, id) {
  if (req.method !== 'PUT') {
    res.writeHead(405, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:'Method not allowed'}));
  }
  const jobFile = path.join(SANDBOX_BASE, id, 'workspace', 'jobs', id, 'job.json');
  let meta;
  try { meta = JSON.parse(await fsp.readFile(jobFile, 'utf8')); }
  catch { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Upload job not found'})); }

  if (req.headers['x-upload-token'] !== meta.uploadToken) {
    res.writeHead(401, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Unauthorized upload.'}));
  }

  const expected = Number(meta.expectedBytes || 0);
  const length = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(length) || length <= 0 || length !== expected || length > MAX) {
    res.writeHead(413, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Upload size does not match the selected video.'}));
  }

  const target = path.join(SANDBOX_BASE, id, 'workspace', 'output', id, 'source.mp4');
  await fsp.mkdir(path.dirname(target), { recursive: true });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target, { mode: 0o600 });
    let bytes = 0;
    let failed = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX && !failed) {
        failed = true;
        req.destroy(new Error('Upload too large.'));
        out.destroy();
      }
    });
    req.on('aborted', () => { failed = true; reject(new Error('Upload aborted.')); });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => {
      if (failed) return;
      resolve();
    });
    req.pipe(out);
  });

  const size = (await fsp.stat(target)).size;
  if (size !== length) {
    try { await fsp.unlink(target); } catch {}
    res.writeHead(400, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:'Uploaded file size mismatch.'}));
  }

  meta.status = 'queued';
  meta.progress = 10;
  meta.message = 'Upload received. Starting analysis…';
  await fsp.writeFile(jobFile, JSON.stringify(meta));

  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:true,size}));
}

async function handleMedia(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 3) { res.writeHead(404); return res.end(); }
  const id = parts[1];
  const file = path.basename(parts[2]);
  const filePath = path.join(SANDBOX_BASE, id, 'workspace', 'output', id, file);

  try {
    const st = await fsp.stat(filePath);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\\d*)-(\\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const requestedEnd = m && m[2] ? Number(m[2]) : st.size - 1;
      const end = Math.min(requestedEnd, st.size - 1);
      if (start > end) {
        res.writeHead(416, {'Content-Range':'bytes */' + st.size});
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type':'video/mp4',
        'Accept-Ranges':'bytes',
        'Content-Range':'bytes ' + start + '-' + end + '/' + st.size,
        'Content-Length':end-start+1
      });
      return fs.createReadStream(filePath, {start, end}).pipe(res);
    }
    res.writeHead(200, {
      'Content-Type':'video/mp4',
      'Content-Length':st.size,
      'Accept-Ranges':'bytes',
      'Content-Disposition':'attachment; filename="' + file + '"'
    });
    return fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Clip not found'}));
  }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (u.pathname === '/' || u.pathname === '/index.html') {
    const html = await fsp.readFile(path.join(__dirname, 'index.html'));
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(html);
  }

  if (u.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    return res.end(JSON.stringify({ok:true,service:'clipping-ai-studio'}));
  }

  if (u.pathname.startsWith('/api/upload-file/')) {
    return handleUploadFile(req, res, u.pathname.split('/').pop());
  }

  if (u.pathname === '/api/upload') {
    if (req.method !== 'POST') { res.writeHead(405,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Method not allowed'})); }
    const body = await jsonBody(req);
    const a = adapt(req, res, body, {});
    return uploadHandler(a.req, a.res);
  }

  if (u.pathname === '/api/analyze') {
    if (req.method !== 'POST') { res.writeHead(405,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Method not allowed'})); }
    const body = await jsonBody(req);
    const a = adapt(req, res, body, {});
    return analyzeHandler(a.req, a.res);
  }

  if (u.pathname.startsWith('/api/jobs/')) {
    const id = u.pathname.split('/').pop();
    const a = adapt(req, res, {}, {id});
    return jobsHandler(a.req, a.res);
  }

  if (u.pathname.startsWith('/media/')) return handleMedia(req, res, u);

  res.writeHead(404, {'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:e.message || 'Server error'}));
  });
}).listen(PORT, '0.0.0.0', () => console.log('Clipping Studio listening on ' + PORT));
