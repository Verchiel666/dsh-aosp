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
  return [`${base}/refs/heads/${ref}`, `${base}/refs/tags/${ref}`, `${base}/${ref}`];
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
export async function downloadTarball(project, ref, destFile, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await downloadOnce(project, ref, destFile);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  throw new Error(`下载 ${project}@${ref} 失败（试了 ${attempts} 次）：${lastErr?.message ?? lastErr}`);
}

async function downloadOnce(project, ref, destFile) {
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
  let sha = null;
  try { sha = (await remoteHead(repoFor(project), ref)).sha; } catch { sha = null; }
  onProgress?.(`下载 ${project}@${ref}${sha ? ' #' + sha.slice(0, 7) : ''} …`);
  const dl = await downloadTarball(project, sha || ref, tgz);
  if (!sha) sha = await tarballSha(tgz, tarPath).catch(() => null);
  onProgress?.(`解包 ${(dl.bytes / 1048576).toFixed(1)} MB …`);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const tTar = Date.now();
  const r = await runShell(tarPath, ['-xzf', tgz, '-C', target, '--strip-components=1'], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`解包失败（tar 退出码 ${r.code}）：${r.stderr.slice(0, 300)}`);
  const extractSecs = (Date.now() - tTar) / 1000;
  onProgress?.(`解包完成 ${extractSecs.toFixed(1)}s`);
  rmSync(tgz, { force: true });
  const stat = countFiles(target);
  const meta = readMeta(root);
  meta.modules[rel] = { project, ref, sha, url: dl.url, fetchedAt: new Date().toISOString(), ...stat, countedAt: new Date().toISOString() };
  writeMeta(root, meta);
  return { skipped: false, dir: target, bytes: dl.bytes, ms: dl.ms, extractMs: Date.now() - tTar, sha, ...stat };
}

export function listModules(root, { refresh = false } = {}) {
  const meta = readMeta(root);
  if (!existsSync(root)) return { root, modules: [] };
  const mods = [];
  let metaDirty = false;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const known = meta.modules[e.name];
    let files = known?.files, bytes = known?.bytes;
    // 有记录的就不重扫：这台机器上扫 56k 个小文件要好几分钟
    if (refresh || typeof files !== 'number' || typeof bytes !== 'number') {
      const stat = countFiles(dir);
      files = stat.files; bytes = stat.bytes;
      meta.modules[e.name] = { ...(known || {}), files, bytes, countedAt: new Date().toISOString() };
      metaDirty = true;
    }
    mods.push({ name: e.name, dir, files, bytes, project: known?.project, ref: known?.ref, sha: known?.sha, fetchedAt: known?.fetchedAt });
  }
  if (metaDirty) writeMeta(root, meta);
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

/** 跨模块正则：一次 rg，结果按模块聚合（每个模块保留前 maxPerModule 条） */
export async function grepByModule({ root, pattern, rgPath, glob, modules, maxPerModule = 5, context = 0, ignoreCase = false }) {
  if (!pattern) throw new Error('pattern 不能为空');
  const args = ['-n', '--no-messages', '--color', 'never', '--no-heading'];
  if (ignoreCase) args.push('-i');
  if (glob) args.push('-g', glob);
  if (context > 0) args.push('-C', String(Math.min(context, 5)));
  args.push('--', pattern, root);
  const r = await runShell(rgPath, args, { timeoutMs: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.code === 1) return { total: 0, modules: [], truncated: false };
  if (r.code !== 0 && r.code !== 2) throw new Error(`rg 退出码 ${r.code}：${r.stderr.slice(0, 300)}`);

  const wanted = modules && modules.length ? new Set(modules.map((m) => String(m).replace(/^\/+|\/+$/g, ''))) : null;
  const per = new Map();
  let total = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const rest = line.startsWith(root + '/') ? line.slice(root.length + 1) : line;
    const idx = rest.indexOf('/');
    const mod = idx > 0 ? rest.slice(0, idx) : '(root)';
    if (wanted && !wanted.has(mod)) continue;
    total++;
    let entry = per.get(mod);
    if (!entry) { entry = { name: mod, count: 0, hits: [] }; per.set(mod, entry); }
    entry.count++;
    if (entry.hits.length < maxPerModule) entry.hits.push(rest);
  }
  const out = [...per.values()].sort((a, b) => b.count - a.count);
  return { total, modules: out, truncated: out.some((m) => m.hits.length < m.count) };
}

// ---------- 增量更新（codeload 没有 diff，借 GitHub compare + jsDelivr 单文件） ----------

export const API = 'https://api.github.com';
export const JSDELIVR = 'https://gcore.jsdelivr.net/gh';

const ghHeaders = { 'user-agent': 'dsh-aosp', accept: 'application/vnd.github+json' };

export async function githubJson(path) {
  const res = await fetch(API + path, { headers: ghHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${path}：${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 远端 ref 的当前 commit sha */
export async function remoteHead(repo, ref = 'main') {
  for (const url of [`/repos/aosp-mirror/${repo}/commits/refs/heads/${ref}`, `/repos/aosp-mirror/${repo}/commits/refs/tags/${ref}`]) {
    try {
      const j = await githubJson(url);
      return { sha: j.sha, date: j.commit?.committer?.date };
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
    }
  }
  throw new Error(`远端找不到 ${repo}@${ref}`);
}

/** compare 两个 commit，返回改动文件列表（API 上限 300 个文件） */
export async function compareCommits(repo, base, head) {
  const j = await githubJson(`/repos/aosp-mirror/${repo}/compare/${base}...${head}`);
  return { status: j.status, files: (j.files || []).map((f) => ({ status: f.status, filename: f.filename, previous: f.previous_filename })), rawTotal: j.files?.length || 0 };
}

/** 按 commit 取单文件内容（jsDelivr 镜像，走通本机网络；比 raw.githubusercontent 可靠） */
export async function fetchRawFile(repo, sha, path) {
  const url = `${JSDELIVR}/aosp-mirror/${repo}@${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: { 'user-agent': 'dsh-aosp' } });
  if (!res.ok) throw new Error(`取文件失败 ${res.status}：${path}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 从 tar 包顶层目录名拿 commit sha（codeload 的包名形如 repo-<sha>/…） */
export async function tarballSha(tgz, tarPath = DEFAULT_TAR) {
  const r = await runShell(tarPath, ['-tzf', tgz], { timeoutMs: 120_000, maxBuffer: 256 * 1024 });
  if (r.code !== 0) return null;
  const first = r.stdout.split('\n').find(Boolean) || '';
  const m = first.match(/^[^/]*?-([0-9a-f]{7,40})\//);
  return m ? m[1] : null;
}

/** 增量更新一个已落地模块：compare → 只下载改动的文件；太大就回退整包 */
export async function updateModule({ project, ref = 'main', root, dest, tarPath = DEFAULT_TAR, maxFiles = 300, onProgress }) {
  const rel = dest || dirNameFor(project);
  const target = safeJoin(root, rel, '目标目录');
  if (!existsSync(target)) throw new Error(`本地还没有 ${rel}，请先用整包下载（aosp_fetch）`);
  const meta = readMeta(root);
  const known = meta.modules[rel];
  if (!known?.sha) throw new Error(`本地 ${rel} 没记录 commit sha（旧版本落的源码），请用 aosp_fetch 并 force:true 重下一次，之后就能增量`);

  const repo = repoFor(project || known.project);
  const head = await remoteHead(repo, ref);
  if (head.sha === known.sha) return { upToDate: true, sha: head.sha, dir: target };

  onProgress?.(`比对 ${known.sha.slice(0, 7)} → ${head.sha.slice(0, 7)} …`);
  const cmp = await compareCommits(repo, known.sha, head.sha);
  if (!cmp.files.length || cmp.files.length > maxFiles) {
    return { fallback: true, reason: cmp.files.length ? `改动 ${cmp.files.length} 个文件，超过上限 ${maxFiles}` : 'compare 没返回文件列表', sha: head.sha, dir: target, changed: cmp.files.length };
  }

  let written = 0, removed = 0, bytes = 0;
  for (const f of cmp.files) {
    const relPath = f.filename;
    const abs = safeJoin(target, relPath, '远端文件路径');
    if (f.status === 'removed') {
      if (existsSync(abs)) { rmSync(abs, { force: true }); removed++; }
      continue;
    }
    if (f.status === 'renamed' && f.previous) {
      const oldAbs = safeJoin(target, f.previous, '旧路径');
      if (existsSync(oldAbs)) { rmSync(oldAbs, { force: true }); removed++; }
    }
    const buf = await fetchRawFile(repo, head.sha, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, buf);
    written++; bytes += buf.length;
  }

  const stat = countFiles(target);
  meta.modules[rel] = { ...known, project: project || known.project, ref, sha: head.sha, updatedAt: new Date().toISOString(), ...stat, countedAt: new Date().toISOString() };
  writeMeta(root, meta);
  return { updated: true, sha: head.sha, dir: target, written, removed, downloadedBytes: bytes, changed: cmp.files.length, totalFiles: stat.files, totalBytes: stat.bytes };
}

// ---------- 镜像仓库发现（aosp-mirror 有哪些仓、多大） ----------

/** 拉 aosp-mirror 的仓库清单（缓存到 <root>/.aosp-mirror.json，默认 24h） */
export async function listMirrorRepos({ cacheFile, refresh = false, ttlMs = 24 * 3600 * 1000 } = {}) {
  if (cacheFile && !refresh && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.repos && Date.now() - (cached.at || 0) < ttlMs) return { repos: cached.repos, cached: true };
    } catch {}
  }
  const repos = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${API}/orgs/aosp-mirror/repos?per_page=100&page=${page}`, { headers: ghHeaders });
    if (!res.ok) throw new Error(`拉仓库清单失败 HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;
    for (const r of list) repos.push({ name: r.name, mb: +(r.size / 1024).toFixed(1), pushedAt: r.pushed_at, archived: !!r.archived });
    if (list.length < 100) break;
  }
  repos.sort((a, b) => b.mb - a.mb);
  if (cacheFile) {
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), repos }));
  }
  return { repos, cached: false };
}

/** 仓库名 → AOSP 项目路径（启发式，platform_frameworks_base → frameworks/base） */
export function repoToPath(name) {
  return String(name).replace(/^platform_/, '').replace(/_/g, '/');
}

/** 按关键词过滤仓库清单 */
export function filterRepos(repos, query = '', limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  const hit = q ? repos.filter((r) => r.name.toLowerCase().includes(q) || repoToPath(r.name).toLowerCase().includes(q)) : repos;
  return hit.slice(0, Math.min(Math.max(Number(limit) || 40, 1), 100));
}

// ---------- 预设包（一次拉一组相关模块） ----------

export const PRESETS = {
  mini: {
    desc: '快速开始：C 库 + 系统核心（约 73 MB）',
    modules: [['system/core', 'system_core'], ['bionic', 'bionic']],
  },
  apps: {
    desc: '看一个完整系统应用：Settings（约 146 MB）',
    modules: [['packages/apps/Settings', 'settings-src']],
  },
  framework: {
    desc: '框架大部头：frameworks/base（约 1.7 GB，解包约 9 分钟）',
    modules: [['frameworks/base', 'frameworks_base']],
  },
  core: {
    desc: '全套框架三件套：system/core + bionic + frameworks/base（约 1.9 GB）',
    modules: [['system/core', 'system_core'], ['bionic', 'bionic'], ['frameworks/base', 'frameworks_base']],
  },
};

export function describePresets() {
  return Object.entries(PRESETS).map(([name, p]) => ({ name, desc: p.desc, count: p.modules.length, modules: p.modules.map((m) => m[0]) }));
}

/** 拉一个预设包；已存在的模块自动跳过 */
export async function fetchPreset({ name, root, tarPath, force = false, onProgress }) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`没有这个预设：${name}（可用：${Object.keys(PRESETS).join(', ')}）`);
  const results = [];
  for (const [project, dest] of preset.modules) {
    onProgress?.(`${project} …`);
    try {
      const r = await fetchProject({ project, ref: 'main', root, dest, force, tarPath });
      results.push({ project, dest, skipped: !!r.skipped, files: r.files, bytes: r.bytes, sha: r.sha, extractMs: r.extractMs });
    } catch (e) {
      results.push({ project, dest, error: e.message });
    }
  }
  return { name, desc: preset.desc, results };
}
