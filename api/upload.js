const crypto = require('crypto');
const { Sandbox } = process.env.RENDER === '1' ? require('../lib/local-sandbox') : require('@vercel/sandbox');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const fileName = String(body.fileName || 'video.mp4').slice(0, 160);
    const fileType = String(body.fileType || 'video/mp4').slice(0, 120);
    const fileSize = Number(body.fileSize || 0);
    if (!fileType.startsWith('video/')) return res.status(400).json({ error: 'Choose a video file.' });
    const maxBytes = 900 * 1024 * 1024;
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > maxBytes) return res.status(400).json({ error: 'Video must be between 1 byte and 900 MB.' });

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    if (process.env.RENDER === '1') {
      const sb = await Sandbox.create({ name: 'clip-job-' + id });
      await sb.writeFiles([{
        path: '/workspace/jobs/' + id + '/job.json',
        content: Buffer.from(JSON.stringify({
          id,
          status: 'waiting_upload',
          progress: 1,
          message: 'Waiting for your video upload…',
          clips: [],
          uploadToken: token,
          expectedBytes: Math.round(fileSize)
        }))
      }]);
      const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
      return res.status(200).json({
        jobId: id,
        uploadUrl: base + '/api/upload-file/' + id,
        uploadToken: token,
        fileName,
        fileType,
        fileSize
      });
    }

    // A persistent sandbox is required because the upload and the later
    // analysis request are separate HTTP requests. Expose the upload port
    // before starting the server inside the sandbox.
    let stage = 'creating sandbox';
    const sb = await Sandbox.create({
      name: 'clip-job-' + id,
      persistent: true,
      timeout: 40 * 60 * 1000,
      ports: [8788],
    });

    stage = 'initializing job state';
    await sb.writeFiles([{
      path: '/workspace/jobs/' + id + '/job.json',
      content: Buffer.from(JSON.stringify({
        id,
        status: 'waiting_upload',
        progress: 1,
        message: 'Waiting for your video upload…',
        clips: [],
        uploadToken: token,
        expectedBytes: Math.round(fileSize)
      }))
    }]);

    stage = 'installing upload server';
    await sb.writeFiles([{
      path: '/workspace/upload-server-' + id + '.js',
      content: Buffer.from("const http = require('node:http');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst token = process.env.UPLOAD_TOKEN || '';\nconst target = process.env.UPLOAD_TARGET || '';\nconst expected = Number(process.env.EXPECTED_BYTES || 0);\nconst maxBytes = 900 * 1024 * 1024;\nfunction cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upload-token'); res.setHeader('Access-Control-Max-Age', '600'); }\nconst server = http.createServer((req, res) => { cors(res); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); } if (req.method !== 'PUT' || req.url !== '/upload') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found' })); } if (req.headers['x-upload-token'] !== token) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unauthorized upload.' })); } const length = Number(req.headers['content-length'] || 0); if (!Number.isFinite(length) || length <= 0 || length > maxBytes) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Upload is larger than 900 MB or has no content length.' })); } if (expected > 0 && length !== expected) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Uploaded size does not match the selected file.' })); } fs.mkdirSync(path.dirname(target), { recursive: true }); const temp = target + '.part'; try { fs.unlinkSync(temp); } catch {} const file = fs.createWriteStream(temp, { mode: 0o600 }); let received = 0; let failed = false; req.on('data', chunk => { received += chunk.length; if (received > maxBytes && !failed) { failed = true; try { file.destroy(); } catch {} try { req.destroy(); } catch {} } }); req.on('aborted', () => { failed = true; try { file.destroy(); } catch {} try { fs.unlinkSync(temp); } catch {} }); file.on('error', () => { if (!failed) { failed = true; try { req.destroy(); } catch {} } }); file.on('finish', () => { if (failed) return; try { const size = fs.statSync(temp).size; if (size !== length || (expected > 0 && size !== expected)) throw new Error('Uploaded file size mismatch.'); fs.renameSync(temp, target); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, size })); setTimeout(() => server.close(() => process.exit(0)), 500); } catch (error) { try { fs.unlinkSync(temp); } catch {} if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message || 'Could not save upload.' })); } }); req.pipe(file); });\nserver.listen(8788, '0.0.0.0');")
    }]);

    stage = 'starting upload server';
    const launch = await sb.runCommand({
      cmd: 'node',
      args: ['/workspace/upload-server-' + id + '.js'],
      detached: true,
      env: {
        UPLOAD_TOKEN: token,
        UPLOAD_TARGET: '/workspace/output/' + id + '/source.mp4',
        EXPECTED_BYTES: String(Math.round(fileSize))
      }
    });
    if (launch.exitCode && launch.exitCode !== 0) {
      let launchError = '';
      try { launchError = await launch.stderr(); } catch {}
      throw new Error('Upload server failed to start (exit ' + launch.exitCode + '). ' + launchError.trim());
    }

    stage = 'verifying upload server';
    let healthy = false;
    let lastHealth = '';
    for (let i = 0; i < 20; i++) {
      const check = await sb.runCommand({
        cmd: 'curl',
        args: ['-fsS', '--max-time', '2', 'http://127.0.0.1:8788/health']
      });
      lastHealth = (await check.stdout()).trim();
      if (check.exitCode === 0 && lastHealth.includes('"ok":true')) {
        healthy = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!healthy) {
      throw new Error('Upload server did not become ready. ' + (lastHealth || 'No health response.'));
    }

    stage = 'creating upload URL';
    const uploadUrl = sb.domain(8788) + '/upload';

    return res.status(200).json({
      jobId: id,
      uploadUrl,
      uploadToken: token,
      fileName,
      fileType,
      fileSize
    });
  } catch (error) {
    console.error('[clip-upload]', stage, error);
    const details = String(error?.message || error || 'Unknown error').slice(0, 1200);
    return res.status(500).json({
      error: 'Could not prepare the upload.',
      stage,
      details
    });
  }
};

module.exports.maxDuration = 60;