const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

const BASE = process.env.CLIP_SANDBOX_DIR || '/tmp/clipping-sandboxes';

function jobIdFromName(name) {
  const m = String(name || '').match(/^clip-job-([a-f0-9-]+)$/i);
  if (!m) throw new Error('Invalid sandbox name.');
  return m[1];
}
function rootFor(id) {
  return path.join(BASE, id, 'workspace');
}
function mapPath(p, root) {
  const s = String(p);
  return s === '/workspace' ? root : s.startsWith('/workspace/') ? root + s.slice('/workspace'.length) : s;
}
function mapText(s, root) {
  return String(s).split('/workspace').join(root);
}

class LocalSandbox {
  constructor(id) { this.id = id; this.root = rootFor(id); }
  static async create(opts = {}) {
    const id = jobIdFromName(opts.name);
    const sb = new LocalSandbox(id);
    await fs.mkdir(sb.root, { recursive: true });
    return sb;
  }
  static async get({ name }) {
    const id = jobIdFromName(name);
    const sb = new LocalSandbox(id);
    await fs.access(sb.root);
    return sb;
  }
  async writeFiles(files) {
    for (const file of files || []) {
      const target = mapPath(file.path, this.root);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content);
    }
  }
  async runCommand({ cmd, args = [], detached = false, env = {} }) {
    const mappedCmd = mapPath(cmd, this.root);
    const mappedArgs = args.map(a => typeof a === 'string' ? mapText(a, this.root) : a);
    const childEnv = {
      ...process.env,
      ...Object.fromEntries(Object.entries(env || {}).map(([k,v]) => [k, typeof v === 'string' ? mapText(v, this.root) : v])),
      CLIP_WORKSPACE_ROOT: this.root
    };
    if (detached) {
      const child = spawn(mappedCmd, mappedArgs, { cwd: this.root, env: childEnv, detached: true, stdio: 'ignore' });
      child.unref();
      return { exitCode: 0, stdout: async () => '', stderr: async () => '' };
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(mappedCmd, mappedArgs, { cwd: this.root, env: childEnv });
      let out = '', err = '';
      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: async () => out,
        stderr: async () => err
      }));
    });
  }
  domain(port) {
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return base || ('http://127.0.0.1:' + (process.env.PORT || 10000));
  }
  localPath(p) { return mapPath(p, this.root); }
}

module.exports = { LocalSandbox, rootFor, BASE };
