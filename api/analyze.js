const { Sandbox } = require('@vercel/sandbox');
const { getVercelOidcToken } = require('@vercel/oidc');
const crypto = require('crypto');

const WORKER = String.raw\`const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readFile, writeFile, mkdir, readdir } = require('node:fs/promises');
const OpenAI = require('openai');

const ex = promisify(execFile);
const job = '__JOB_ID__';
const url = __URL__;
const root = '/workspace';
const dir = root + '/jobs/' + job;
const out = root + '/output/' + job;
const jf = dir + '/job.json';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function st(progress, message, status = 'processing', extra = {}) {
  let j = { id: job, status, progress, message, clips: [] };
  try { j = { ...JSON.parse(await readFile(jf, 'utf8')), ...j, ...extra }; } catch {}
  await writeFile(jf, JSON.stringify(j));
}

async function cmd(command, args, options = {}) {
  return (await ex(command, args, { maxBuffer: 1024 * 1024 * 50, ...options })).stdout;
}

async function ensureTools() {
  try { require.resolve('openai'); } catch { await cmd('npm', ['install', '--silent', 'openai']); }
  try { await cmd('ffmpeg', ['-version']); }
  catch {
    await cmd('sudo', ['apt-get', 'update', '-qq']);
    await cmd('sudo', ['apt-get', 'install', '-y', 'ffmpeg']);
  }
  try { await cmd('yt-dlp', ['--version']); }
  catch { await cmd('python3', ['-m', 'pip', 'install', '-q', 'yt-dlp']); }
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = ms % 1000;
  return \`\${String(h).padStart(2,'0')}:\${String(m).padStart(2,'0')}:\${String(s).padStart(2,'0')},\${String(z).padStart(3,'0')}\`;
}

async function transcribeInChunks(audio) {
  const chunkDir = out + '/audio-chunks';
  await mkdir(chunkDir, { recursive: true });
  await cmd('ffmpeg', ['-y','-i',audio,'-f','segment','-segment_time','600','-c:a','libmp3lame','-b:a','96k',chunkDir+'/part-%03d.mp3']);
  const files = (await readdir(chunkDir)).filter(x => x.endsWith('.mp3')).sort();
  const all = [];
  for (let i = 0; i < files.length; i++) {
    const file = chunkDir + '/' + files[i];
    const offset = i * 600;
    const r = await openai.audio.transcriptions.create({
      file: require('fs').createReadStream(file),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });
    for (const s of (r.segments || [])) {
      const start = offset + Number(s.start || 0);
      const end = offset + Number(s.end || 0);
      if (end > start && String(s.text || '').trim()) {
        all.push({ start, end, text: String(s.text).trim() });
      }
    }
    await st(18 + Math.round(((i + 1) / files.length) * 18), \`Transcribing part \${i + 1} of \${files.length}…\`);
  }
  if (!all.length) throw new Error('OpenAI returned no timestamped transcript segments.');
  return all;
}

function makeSrt(segments, start, end) {
  const selected = segments.filter(s => s.end > start && s.start < end);
  return selected.map((s, i) => {
    const a = Math.max(0, s.start - start);
    const b = Math.min(end - start, s.end - start);
    return \`\${i + 1}\\n\${srtTime(a)} --> \${srtTime(b)}\\n\${s.text}\\n\`;
  }).join('\\n');
}

async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured on the worker.');
    await mkdir(out, { recursive: true });
    await st(3, 'Preparing the video engine…');
    await ensureTools();

    await st(9, 'Fetching the authorized source video…');
    await cmd('yt-dlp', [
      '--no-playlist',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
      '--merge-output-format', 'mp4',
      '-o', out + '/source.%(ext)s',
      url
    ]);
    const source = (await readdir(out)).find(x => /^source\\./.test(x) && x.endsWith('.mp4'));
    if (!source) throw new Error('The source video could not be downloaded.');
    const sourcePath = out + '/' + source;

    await st(16, 'Extracting audio for AI analysis…');
    await cmd('ffmpeg', ['-y','-i',sourcePath,'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','96k',out+'/audio.mp3']);

    await st(18, 'Transcribing with OpenAI…');
    const segs = await transcribeInChunks(out + '/audio.mp3');
    await writeFile(out + '/transcript.json', JSON.stringify(segs));

    const transcript = segs.map((s, i) =>
      \`\${i}|\\\${s.start.toFixed(2)}-\${s.end.toFixed(2)}|\\\${s.text}\`
    ).join('\\n');

    await st(38, 'AI is scoring hooks, retention and shareability…');
    const prompt = \`You are the senior editor for a premium short-form clipping studio.

Select exactly 50 DISTINCT moments from this transcript that have the strongest potential as standalone short-form videos.

Optimize for:
1. An immediate hook in the first seconds.
2. Curiosity or a strong unanswered question.
3. Emotional intensity, surprise, humor, conflict, or a memorable story.
4. A clear payoff or useful insight.
5. Self-contained context: the viewer should understand the clip without the full video.
6. Quotability and shareability.
7. Strong beginning and ending; avoid clips that require missing context.

Reject greetings, introductions, filler, repetition, rambling, weak setup, sponsor reads and moments whose meaning depends heavily on earlier unseen material.

Target 18-65 seconds. Prefer 25-55 seconds when possible. Do not overlap clips unless they are genuinely different moments.

Return ONLY valid JSON:
{"clips":[{"rank":1,"start":12.3,"end":48.7,"title":"short compelling title","score":96,"reason":"one short reason"}]}

Score from 0-100. Use the transcript timestamps exactly and keep start/end within the source.

TRANSCRIPT:
\${transcript}\`;

    const r = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'You are an expert short-form video editor. Output only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(r.choices?.[0]?.message?.content || '{}');
    const picks = (Array.isArray(parsed.clips) ? parsed.clips : [])
      .map((p, i) => {
        const start = Math.max(0, Number(p.start) - 1.2);
        const end = Math.max(start + 12, Math.min(Number(p.end) + 0.8, start + 65));
        return {
          rank: i + 1,
          start,
          end,
          title: String(p.title || 'Untitled clip').slice(0, 100),
          score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
          reason: String(p.reason || '').slice(0, 180)
        };
      })
      .filter(p => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);

    if (picks.length < 1) throw new Error('OpenAI did not return usable clip selections.');
    picks.sort((a,b) => b.score - a.score);
    picks.forEach((p,i) => p.rank = i + 1);
    const finalPicks = picks.slice(0, 50);

    await st(42, \`Rendering \${finalPicks.length} selected clips…\`);
    const done = [];
    let cursor = 0;

    async function renderOne(p, i) {
      const name = 'clip-' + String(i + 1).padStart(2, '0') + '.mp4';
      const srt = out + '/caption-' + String(i + 1).padStart(2, '0') + '.srt';
      await writeFile(srt, makeSrt(segs, p.start, p.end));
      await cmd('ffmpeg', [
        '-y','-ss',String(p.start),'-i',sourcePath,'-t',String(p.end-p.start),
        '-vf', \`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,subtitles=\${srt}:force_style='FontName=Arial,FontSize=18,Bold=1,Outline=2,Shadow=1,Alignment=2,MarginV=90'\`,
        '-c:v','libx264','-preset','veryfast','-crf','20',
        '-c:a','aac','-b:a','128k','-movflags','+faststart',out+'/'+name
      ]);
      return {
        id: String(i + 1),
        rank: i + 1,
        title: p.title,
        duration: Math.round(p.end - p.start),
        score: p.score,
        reason: p.reason
      };
    }

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= finalPicks.length) return;
        const result = await renderOne(finalPicks[i], i);
        done[i] = result;
        const completed = done.filter(Boolean).length;
        await st(42 + Math.round((completed / finalPicks.length) * 56), \`Rendering clip \${completed} of \${finalPicks.length}…\`, 'processing', { clips: done.filter(Boolean) });
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, finalPicks.length) }, () => worker()));
    await writeFile(jf, JSON.stringify({
      id: job, status: 'done', progress: 100,
      message: \`Finished \${done.length} clips.\`,
      clips: done
    }));
  } catch (e) {
    await st(100, 'Processing failed', 'error', { error: e?.stderr || e?.message || String(e) });
  }
}

main();\`;

exports.maxDuration = 60;

exports.default = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\\/\\/(www\\.)?(youtube\\.com|youtu\\.be)\\//i.test(url)) {
      return res.status(400).json({ error: 'Use a valid YouTube URL.' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI is not connected yet. Add OPENAI_API_KEY to the Vercel project environment variables.' });
    }

    const token = await getVercelOidcToken();
    const sb = await Sandbox.getOrCreate({
      name: 'suleimanzlatyn-worker',
      runtime: 'node24',
      timeout: 86400000,
      resources: { vcpus: 4 },
      ports: [8787],
      networkPolicy: { mode: 'allow-all' }
    });

    const id = crypto.randomUUID();
    await sb.writeFiles([{
      path: '/workspace/jobs/' + id + '/job.json',
      content: Buffer.from(JSON.stringify({
        id, status: 'queued', progress: 1,
        message: 'Preparing the analysis worker…', clips: []
      }))
    }]);

    const script = WORKER.replaceAll('__JOB_ID__', id).replace('__URL__', JSON.stringify(url));
    const workerPath = '/workspace/run-' + id + '.mjs';
    await sb.writeFiles([{ path: workerPath, content: Buffer.from(script) }]);

    await sb.runCommand({
      cmd: 'bash',
      args: ['-lc', 'nohup node ' + workerPath + ' >/workspace/jobs/' + id + '/worker.log 2>&1 &'],
      env: { VERCEL_OIDC_TOKEN: token, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    });

    await sb.runCommand({
      cmd: 'bash',
      args: ['-lc', 'mkdir -p /workspace/output; pgrep -f "http.server 8787" >/dev/null || nohup python3 -m http.server 8787 --directory /workspace >/workspace/http.log 2>&1 &'],
      env: { VERCEL_OIDC_TOKEN: token }
    });

    return res.json({ jobId: id, status: 'queued' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Could not start worker' });
  }
};
