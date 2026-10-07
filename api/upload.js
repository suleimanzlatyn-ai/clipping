const crypto = require('crypto');
const { Sandbox } = require('@vercel/sandbox');

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
    // Keep upload preparation on the simplest Sandbox configuration.
    // The upload endpoint only needs a public HTTP port; processing resources
    // are requested later by the analysis worker.
    const sb = await Sandbox.create({
      name: 'clip-job-' + id,
      timeout: 30 * 60 * 1000,
      ports: [8788]
    });

    await sb.writeFiles([{
      path: '/workspace/jobs/' + id + '/job.json',
      content: Buffer.from(JSON.stringify({ id, status: 'waiting_upload', progress: 1, message: 'Waiting for your video upload…', clips: [] }))
    }]);

    await sb.writeFiles([{
      path: '/workspace/upload-server-' + id + '.js',
      content: Buffer.from("const http = require('node:http');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst token = process.env.UPLOAD_TOKEN || '';\nconst target = process.env.UPLOAD_TARGET || '';\nconst expected = Number(process.env.EXPECTED_BYTES || 0);\nconst maxBytes = 900 * 1024 * 1024;\nfunction cors(res) {\n  res.setHeader('Access-Control-Allow-Origin', '*');\n  res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS');\n  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upload-token');\n  res.setHeader('Access-Control-Max-Age', '600');\n}\nconst server = http.createServer((req, res) => {\n  cors(res);\n  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }\n  if (req.method !== 'PUT' || req.url !== '/upload') {\n    res.writeHead(404, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ error: 'Not found' }));\n  }\n  if (req.headers['x-upload-token'] !== token) {\n    res.writeHead(401, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ error: 'Unauthorized upload.' }));\n  }\n  const length = Number(req.headers['content-length'] || 0);\n  if (!Number.isFinite(length) || length <= 0 || length > maxBytes) {\n    res.writeHead(413, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ error: 'Upload is larger than 900 MB or has no content length.' }));\n  }\n  if (expected > 0 && length !== expected) {\n    res.writeHead(400, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ error: 'Uploaded size does not match the selected file.' }));\n  }\n  fs.mkdirSync(path.dirname(target), { recursive: true });\n  const temp = target + '.part';\n  try { fs.unlinkSync(temp); } catch {}\n  const file = fs.createWriteStream(temp, { mode: 0o600 });\n  let received = 0;\n  let failed = false;\n  req.on('data', chunk => {\n    received += chunk.length;\n    if (received > maxBytes && !failed) {\n      failed = true;\n      try { file.destroy(); } catch {}\n      try { req.destroy(); } catch {}\n    }\n  });\n  req.on('aborted', () => {\n    failed = true;\n    try { file.destroy(); } catch {}\n    try { fs.unlinkSync(temp); } catch {}\n  });\n  file.on('error', () => {\n    if (!failed) { failed = true; try { req.destroy(); } catch {} }\n  });\n  file.on('finish', () => {\n    if (failed) return;\n    try {\n      const size = fs.statSync(temp).size;\n      if (size !== length || (expected > 0 && size !== expected)) throw new Error('Uploaded file size mismatch.');\n      fs.renameSync(temp, target);\n      res.writeHead(200, { 'Content-Type': 'application/json' });\n      res.end(JSON.stringify({ ok: true, size }));\n      setTimeout(() => server.close(() => process.exit(0)), 500);\n    } catch (error) {\n      try { fs.unlinkSync(temp); } catch {}\n      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });\n      res.end(JSON.stringify({ error: error.message || 'Could not save upload.' }));\n    }\n  });\n  req.pipe(file);\n});\nserver.listen(8788, '0.0.0.0');")
    }]);

    await sb.runCommand({
      cmd: 'node',
      args: ['/workspace/upload-server-' + id + '.js'],
      detached: true,
      env: {
        UPLOAD_TOKEN: token,
        UPLOAD_TARGET: '/workspace/output/' + id + '/source.mp4',
        EXPECTED_BYTES: String(Math.round(fileSize))
      }
    });

    return res.status(200).json({
      jobId: id,
      uploadUrl: sb.domain(8788) + '/upload',
      uploadToken: token,
      fileName,
      fileType,
      fileSize
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not prepare the upload.' });
  }
};

module.exports.maxDuration = 30;