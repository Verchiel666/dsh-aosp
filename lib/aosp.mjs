// lib/aosp.mjs — dsh-aosp 的核心逻辑（纯 JS 下载 + 系统 tar 解包 + rg 搜索）
//
// 为什么不用 git：本机 github.com 不通，AOSP 的中科大镜像 git fetch 会卡死（实测停在 119 KB）；
// 而 codeload.github.com 可达（实测 3–12 MB/s），aosp-mirror 组织镜像了 AOSP 主要项目。
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const MIRROR = 'https://codeload.github.com/aosp-mirror';
export const META = '.dsh-aosp.json';
const DEFAULT_TAR = '/system/bin/tar';

/** AOSP 项目路径 → aosp-mirror 仓库名（platform_frameworks_base…） */
export function repoFor(project) {
  const p = String(project || '').trim().replace(/^\/+|\/+$/g, '');
  if (!p) throw new Error('project 不能为空，例如 frameworks/base');
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error(`项目路径含非法字符：${p}`);
  return p.startsWith('platform/') ? p.replace(/\//g, '_') : 'platform_' + p.replace(/\//g, '_');
}

/** 本地目录名：frameworks/base → frameworks_base */
export function dirNameFor(project) {
  return String(project).trim().replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
}

export function tarballUrls(project, ref = 'main') {
  const repo = repoFor(project);
  const base = `${MIRROR}/${repo}/tar.gz`;
  return [`${base}/refs/heads/${ref}`, `${base}/refs/tags/${ref}`];
}

/** 把 dest 限制在 root 之内，挡住 ../ 穿越 */
export function safeJoin(root, rel, what = '路径') {
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) throw new Error(`${what}越界：${rel}`);
  return abs;
}

export function readMeta(root) {
  const f = join(root, META);
  if (!existsSync(f)) return { modules: {} };
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return { modules: {} }; }
}

export function writeMeta(root, meta) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, META), JSON.stringify(meta, null, 2));
}

async function pickUrl(project, ref) {
  for (const url of tarballUrls(project, ref)) {
    const res = await fetch(url, { method: 'GET', headers: { 'user-agent': 'dsh-aosp' } });
    if (res.ok) return { url, res };
    await res.body?.cancel?.();
  }
  throw new Error(`找不到 ${project}@${ref}（分支和 tag 都 404）。先确认项目名，或换 ref。`);
}

/** 下载 tar.gz 到文件，返回字节数与耗时 */
export async function downloadTarball(project, ref, destFile) {
  const t0 = Date.now();
  const { url, res } = await pickUrl(project, ref);
  mkdirSync(join(destFile, '..'), { recursive: true });
  const ws = createWriteStream(destFile);
  let bytes = 0;
  for await (const chunk of res.body) { ws.write(chunk); bytes += chunk.length; }
  await new Promise((r) => ws.end(r));
  return { bytes, ms: Date.now() - t0, url };
}

export function runShell(cmd, args, { cwd, timeoutMs = 120_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { p.kill('SIGKILL'); } }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < maxBuffer) out += d.toString(); });
    p.stderr.on('data', (d) => { if (err.length < maxBuffer) err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); if (!done) { done = true; reject(e); } });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      resolvePromise({ code, stdout: out, stderr: err });
    });
  });
}

export function countFiles(dir) {
  let n = 0, bytes = 0;
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { n++; try { bytes += statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return { files: n, bytes };
}

/** 下载 + 解包一个项目；已存在且非 force 时跳过 */
export async function fetchProject({ project, ref = 'main', root, dest, force = false, tarPath = DEFAULT_TAR, onProgress }) {
  const rel = dest || dirNameFor(project);
  const target = safeJoin(root, rel, '目标目录');
  if (existsSync(target) && !force) {
    const stat = countFiles(target);
    return { skipped: true, dir: target, ...stat };
  }
  mkdirSync(root, { recursive: true });
  const tgz = join(root, `.${rel}.tar.gz`);
  onProgress?.(`下载 ${project}@${ref} …`);
  const dl = await downloadTarball(project, ref, tgz);
  onProgress?.(`解包 ${(dl.bytes / 1048576).toFixed(1)} MB …`);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const r = await runShell(tarPath, ['-xzf', tgz, '-C', target, '--strip-components=1'], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`解包失败（tar ${r.code}）：${r.stderr.slice(0, 400)}`);
  rmSync(tgz, { force: true });
  const stat = countFiles(target);
  const meta = readMeta(root);
  meta.modules[rel] = { project, ref, url: dl.url, fetchedAt: new Date().toISOString(), bytes: dl.bytes, ...stat };
  writeMeta(root, meta);
  return { skipped: false, dir: target, bytes: dl.bytes, ms: dl.ms, ...stat };
}

export function listModules(root) {
  const meta = readMeta(root);
  if (!existsSync(root)) return { root, modules: [] };
  const mods = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const known = meta.modules[e.name];
    const { files, bytes } = countFiles(dir);
    mods.push({ name: e.name, dir, files, bytes, project: known?.project, ref: known?.ref, fetchedAt: known?.fetchedAt });
  }
  mods.sort((a, b) => b.bytes - a.bytes);
  return { root, modules: mods };
}

export function defaultRgPath(home) {
  const p = join(home, '..', 'bin', 'rg');
  return existsSync(p) ? p : 'rg';
}

/** 在 root 下用 rg 搜索 */
export async function search({ root, pattern, rgPath, glob, maxResults = 60, context = 0, ignoreCase = false }) {
  if (!pattern) throw new Error('pattern 不能为空');
  const args = ['-n', '--no-messages', '--color', 'never', '--no-heading'];
  if (ignoreCase) args.push('-i');
  if (glob) args.push('-g', glob);
  if (context > 0) args.push('-C', String(Math.min(context, 5)));
  args.push('--', pattern, root);
  const r = await runShell(rgPath, args, { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.code === 1) return { hits: [], total: 0, truncated: false };
  if (r.code !== 0 && r.code !== 2) throw new Error(`rg 退出码 ${r.code}：${r.stderr.slice(0, 300)}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  const hits = lines.slice(0, maxResults).map((l) => l.replace(root + '/', ''));
  return { hits, total: lines.length, truncated: lines.length > maxResults };
}

/** 读 root 下的文本文件（带行号） */
export function readModuleFile({ root, path, offset = 1, limit = 120 }) {
  const abs = safeJoin(root, path, '文件路径');
  if (!existsSync(abs)) throw new Error(`文件不存在：${path}`);
  const all = readFileSync(abs, 'utf8').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const start = Math.max(0, offset - 1);
  const slice = all.slice(start, start + Math.min(Math.max(limit, 1), 400));
  const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`);
  return { lines: numbered, total: all.length, shown: slice.length, start };
}
