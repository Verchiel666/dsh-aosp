// dsh-aosp — 在 DSH 里直接拉 AOSP 源码并在本机搜代码（无需 root、无需 git）
//
// 背景：本机 github.com 不通、AOSP 国内 git 镜像的 fetch 会卡死（实测停在 119 KB）；
// 但 codeload.github.com 可达，aosp-mirror 组织镜像了 AOSP 主要项目，
// 所以走「tar 快照 → 系统 tar 解包 → rg 搜索」这条路。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { trace as traceCalls } from './lib/trace.mjs';
import {
  fetchProject, listModules, search, grepByModule, readModuleFile, defaultRgPath, repoFor, updateModule,
  listMirrorRepos, filterRepos, repoToPath, PRESETS, describePresets, fetchPreset,
} from './lib/aosp.mjs';

export const name = 'aosp';
export const inject = ['tools'];

const READ = 'risk: read (read-only)';
const WRITE = 'risk: write (changes the phone)';

const text = (t) => [{ type: 'text', text: t }];
const renderer = (_args, value) => (Array.isArray(value?.content) ? value.content : text(JSON.stringify(value, null, 2)));
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('aosp') : { info() {}, warn() {} };
  const rootDir = config.rootDir || join(homedir(), 'work', 'aosp-src');
  const rgPath = config.rgPath || defaultRgPath(homedir());
  const tarPath = config.tarPath || '/system/bin/tar';
  const fyi = `源码根目录: ${rootDir}`;

  const tools = [
    {
      name: 'aosp_preset',
      description: `预设包：一次拉一组相关模块（mini / apps / framework / core）。不带 name 时列出预设与本地已落地情况。
[
${WRITE}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '预设名：mini / apps / framework / core；留空只列出' },
          force: { type: 'boolean', description: '已落地也重新下载' },
        },
      },
      timeoutMs: 1_800_000,
      isConcurrencySafe: () => false,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const landed = new Set(listModules(rootDir).modules.map((m) => m.name));
        if (!args?.name) {
          const lines = describePresets().map((p) => {
            const mark = PRESETS[p.name].modules.map(([, d]) => (landed.has(d) ? '✔' : '·')).join('');
            return `${p.name.padEnd(10)} ${mark.padEnd(6)} ${p.desc}`;
          });
          return { content: text([`预设（✔=已落地，·=未拉）：`, '', ...lines, '', '拉取：aosp_preset {"name":"mini"}', fyi].join('\n')) };
        }
        const res = await fetchPreset({ name: args.name, root: rootDir, tarPath, force: !!args.force });
        const lines = [`预设 ${res.name}：${res.desc}`, ''];
        for (const r of res.results) {
          if (r.error) { lines.push(`❌ ${r.project}：${r.error}`); continue; }
          if (r.skipped) { lines.push(`✔ ${r.project}（已存在，跳过）`); continue; }
          lines.push(`✅ ${r.project} → ${r.dest}：${(r.files ? '' : '')}${r.files} 文件，解包 ${((r.extractMs || 0) / 1000).toFixed(1)}s，sha ${String(r.sha || '').slice(0, 7)}`);
        }
        return { content: text(lines.join('\n')) };
      },
    },
    {
      name: 'aosp_list',
      description: `列出本机已落地的 AOSP 源码模块（大小/文件数/来源 ref）。\n[${READ}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: '重新统计每个模块的文件数/体积（默认用缓存，56k 文件重扫要好几分钟）' },
        },
      },
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const { modules } = listModules(rootDir, { refresh: !!args?.refresh });
        if (!modules.length) return { content: text(`还没有任何模块。用 aosp_fetch 拉一个，例如 {"project":"frameworks/base"}。\n${fyi}`) };
        const total = modules.reduce((a, m) => a + m.bytes, 0);
        const lines = modules.map((m) =>
          `${m.name.padEnd(28)} ${mb(m.bytes).padStart(9)}  ${String(m.files).padStart(6)} 文件  ${m.ref ? '@' + m.ref : ''}${m.sha ? ' #' + String(m.sha).slice(0, 7) : ''}`);
        return { content: text([`共 ${modules.length} 个模块 / ${mb(total)}`, '', ...lines, '', fyi].join('\n')) };
      },
    },
    {
      name: 'aosp_mirror',
      description: `看 aosp-mirror 上到底有哪些仓（100 个，带体积和最后 push 时间），用来判断「某个项目能不能拉到」。
[
${READ}; 缓存 24h]`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词过滤（仓库名或推导出的项目路径），例如 frameworks、bionic、Settings' },
          limit: { type: 'number', description: '最多返回几条（默认 40，上限 100）' },
          refresh: { type: 'boolean', description: '忽略 24h 缓存，重新拉清单' },
        },
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const { repos, cached } = await listMirrorRepos({
          cacheFile: join(rootDir, '.aosp-mirror.json'), refresh: !!args?.refresh,
        });
        const hits = filterRepos(repos, args?.query, args?.limit);
        if (!hits.length) return { content: text(`没有匹配「${args?.query}」的仓；共 ${repos.length} 个仓可用。`) };
        const lines = hits.map((r) => `${repoToPath(r.name).padEnd(30)} ${String(r.mb).padStart(8)} MB  ${r.pushedAt ? r.pushedAt.slice(0, 10) : ''}`);
        const head = `aosp-mirror 共 ${repos.length} 个仓${cached ? '（缓存）' : '（刚拉取）'}，匹配 ${hits.length} 条：`;
        return { content: text([head, '', ...lines, '', '拉取：aosp_fetch {"project":"<左侧的项目路径>"}'].join('\n')) };
      },
    },
    {
      name: 'aosp_fetch',
      description: `从 GitHub aosp-mirror 下载一个 AOSP 项目的 tar 快照并解包到本机（分支或 tag 都可，如 android-14.0.0_r1）。\n已存在则跳过（force 才重下）。只下源码，不编译。\n[${WRITE}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'AOSP 项目路径，例如 frameworks/base、packages/apps/Settings、system/core、bionic' },
          ref: { type: 'string', description: '分支或 tag，默认 main；也可用 android-14.0.0_r1 这类版本 tag' },
          dest: { type: 'string', description: '解包到的目录名（相对源码根目录），默认为项目路径把 / 换成 _' },
          force: { type: 'boolean', description: '已存在时也重新下载' },
        },
        required: ['project'],
      },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const project = args?.project;
        if (!project) throw new Error('project 不能为空');
        const ref = args?.ref || 'main';
        const repo = repoFor(project);
        const notes = [];
        const res = await fetchProject({
          project, ref, root: rootDir, dest: args?.dest, force: !!args?.force,
          tarPath, onProgress: (m) => notes.push(m),
        });
        if (res.skipped) {
          return { content: text(`已存在，跳过：${res.dir}\n（${mb(res.bytes)} / ${res.files} 个文件；要重下加 force:true）`) };
        }
        const secs = (res.ms / 1000).toFixed(1);
        return {
          content: text([
            `✅ ${project}@${ref} → ${res.dir}`,
            `仓库：aosp-mirror/${repo}`,
            `下载 ${mb(res.bytes)} / ${secs}s（${(res.bytes / 1024 / Math.max(res.ms / 1000, 0.01)).toFixed(0)} KB/s），解包后 ${mb(res.files ? res.bytes : res.bytes)}`.replace('解包后 ' + mb(res.bytes), `解包后 ${res.files} 个文件`),
            '',
            `搜索：aosp_search {"pattern":"class ActivityManagerService","glob":"*.java"}`,
          ].join('\n')),
        };
      },
    },
    {
      name: 'aosp_update',
      description: `增量更新一个已落地模块：比对远端 commit，只下载改动/新增的文件（改名按改名处理，删除照删）。
改动超过上限或没记录 sha 时，会提示改用 aosp_fetch 整包重下。
[${WRITE}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          module: { type: 'string', description: '本地模块目录名，例如 frameworks_base' },
          project: { type: 'string', description: 'AOSP 项目路径（module 已存在记录时可省略）' },
          ref: { type: 'string', description: '分支或 tag，默认 main' },
          maxFiles: { type: 'number', description: '改动文件数上限，超过则回退整包（默认 300）' },
        },
        required: ['module'],
      },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      output: { schema: {}, render: renderer },
      async execute(args) {
        if (!args?.module) throw new Error('module 不能为空');
        const notes = [];
        const res = await updateModule({
          project: args.project, ref: args.ref || 'main', root: rootDir, dest: args.module,
          tarPath, maxFiles: Math.min(Math.max(Number(args.maxFiles) || 300, 1), 300),
          onProgress: (m) => notes.push(m),
        });
        if (res.upToDate) return { content: text(`已是最新：${args.module} @ ${String(res.sha).slice(0, 7)}`) };
        if (res.fallback) {
          return { content: text([`需要整包重下：${res.reason}`, `aosp_fetch {"project":"${args.project || '(模块记录里的项目)'}","ref":"${args.ref || 'main'}","force":true}`].join('\n')) };
        }
        return {
          content: text([
            `✅ 增量更新 ${args.module} → ${String(res.sha).slice(0, 7)}`,
            `本次改动 ${res.changed} 个文件：写入 ${res.written}、删除 ${res.removed}，下载 ${(res.downloadedBytes / 1024).toFixed(0)} KB`,
            `当前目录 ${res.totalFiles} 个文件 / ${(res.totalBytes / 1048576).toFixed(1)} MB`,
          ].join('\n')),
        };
      },
    },
    {
      name: 'aosp_trace',
      description: `启发式调用链：给一个函数名，顺着「它调了谁」或「谁调了它」往下钻 1–3 层（rg + 花括号配对，不跑编译器）。
[
${READ}; 太通用的名字不会继续展开，避免刷屏]`,
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '函数/方法名，例如 startProcessLocked、handleBindApplication' },
          direction: { type: 'string', description: 'callees（它调了谁，默认）/ callers（谁调了它）/ both' },
          depth: { type: 'number', description: '展开层数 1–3（默认 2）' },
          maxPerLevel: { type: 'number', description: '每层最多几个（默认 5，上限 10）' },
          glob: { type: 'string', description: '限定文件，例如 *.java / *.cpp' },
          includeTests: { type: 'boolean', description: '是否包含 tests 目录（默认排除）' },
        },
        required: ['symbol'],
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const direction = ['callees', 'callers', 'both'].includes(args?.direction) ? args.direction : 'callees';
        const depth = Math.min(Math.max(Number(args?.depth) || 2, 1), 3);
        const maxPerLevel = Math.min(Math.max(Number(args?.maxPerLevel) || 5, 1), 10);
        const res = await traceCalls({
          root: rootDir, symbol: args?.symbol, rgPath, depth, direction, maxPerLevel,
          glob: args?.glob || '*', includeTests: !!args?.includeTests,
        });
        const lines = [`跟踪 ${res.symbol}（方向 ${direction}，深度 ${depth}）`];
        for (const lv of res.levels) {
          const defs = lv.nodes.filter((n) => !n.kind || n.kind === 'definition');
          const callees = lv.nodes.filter((n) => n.kind === 'callee');
          const callers = lv.nodes.filter((n) => n.kind === 'caller');
          const skipped = lv.nodes.filter((n) => n.kind === 'skipped-generic');
          if (lv.level === 0) {
            if (!defs.length) { lines.push('', '没找到定义——换个更完整的名字，或先 aosp_search 一下'); break; }
            lines.push('', `L0 定义（${defs.length}）`);
            for (const d of defs) lines.push(`  ${d.file}:${d.line}  ${String(d.text || '').slice(0, 90)}`);
            continue;
          }
          lines.push('', `L${lv.level}（${lv.nodes.length - skipped.length} 条${skipped.length ? `，通用名未展开 ${skipped.length}` : ''}）`);
          for (const n of callees.slice(0, maxPerLevel)) lines.push(`  ⇒ ${n.symbol}   ← ${n.via}`);
          for (const n of callers.slice(0, maxPerLevel)) lines.push(`  ⇐ ${String(n.symbol).slice(0, 70)}   ← ${n.via}`);
          if (skipped.length) lines.push(`  ·（未展开：${skipped.slice(0, 6).map((s) => s.symbol).join(', ')}${skipped.length > 6 ? '…' : ''}）`);
        }
        lines.push('', '启发式结果：按 rg 匹配 + 花括号配对展开，不是精确调用图（重载/反射/宏看不到）。');
        return { content: text(lines.join('\n')) };
      },
    },
    {
      name: 'aosp_search',
      description: `在已落地的 AOSP 源码里用 ripgrep 搜正则（默认返回 60 条）。\n[${READ}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ripgrep 正则' },
          glob: { type: 'string', description: '限定文件，例如 *.java / *.cpp / *.bp' },
          maxResults: { type: 'number', description: '最多返回条数（默认 60，上限 300）' },
          context: { type: 'number', description: '上下文行数（0–5）' },
          ignoreCase: { type: 'boolean', description: '忽略大小写' },
        },
        required: ['pattern'],
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const maxResults = Math.min(Math.max(Number(args?.maxResults) || 60, 1), 300);
        const { hits, total, truncated } = await search({
          root: rootDir, pattern: args?.pattern, rgPath, glob: args?.glob,
          maxResults, context: Number(args?.context) || 0, ignoreCase: !!args?.ignoreCase,
        });
        if (!total) return { content: text(`没有匹配「${args?.pattern}」${args?.glob ? `（glob ${args.glob}）` : ''}。`) };
        return { content: text([`命中 ${total} 行${truncated ? `，只显示前 ${maxResults}` : ''}：`, '', ...hits].join('\n')) };
      },
    },
    {
      name: 'aosp_grep',
      description: `跨模块正则搜索：一次 rg，结果按源码模块聚合（每个模块先给几条代表命中），适合「这个东西在哪几个模块里出现」。\n[${READ}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ripgrep 正则' },
          glob: { type: 'string', description: '限定文件，例如 *.java / *.cpp' },
          modules: { type: 'array', items: { type: 'string' }, description: '只在这些模块里搜（默认全部）' },
          maxPerModule: { type: 'number', description: '每个模块最多显示几条（默认 5）' },
          context: { type: 'number', description: '上下文行数（0–5）' },
          ignoreCase: { type: 'boolean', description: '忽略大小写' },
        },
        required: ['pattern'],
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const maxPerModule = Math.min(Math.max(Number(args?.maxPerModule) || 5, 1), 20);
        const res = await grepByModule({
          root: rootDir, pattern: args?.pattern, rgPath, glob: args?.glob,
          modules: Array.isArray(args?.modules) ? args.modules : null,
          maxPerModule, context: Number(args?.context) || 0, ignoreCase: !!args?.ignoreCase,
        });
        if (!res.total) return { content: text(`没有匹配「${args?.pattern}」${args?.glob ? `（glob ${args.glob}）` : ''}。`) };
        const lines = [`命中 ${res.total} 行，分布在 ${res.modules.length} 个模块：`];
        for (const m of res.modules) {
          lines.push('', `【${m.name}】${m.count} 行` + (m.hits.length < m.count ? `（显示前 ${m.hits.length}）` : ''));
          for (const h of m.hits) lines.push('  ' + h);
        }
        return { content: text(lines.join('\n')) };
      },
    },
    {
      name: 'aosp_read',
      description: `按行读已落地源码里的一个文件（带行号，最多 400 行）。\n[${READ}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对源码根目录的路径，例如 frameworks_base/core/java/android/os/Build.java' },
          offset: { type: 'number', description: '起始行（1 起）' },
          limit: { type: 'number', description: '读多少行（默认 120，上限 400）' },
        },
        required: ['path'],
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const r = readModuleFile({ root: rootDir, path: args?.path, offset: args?.offset, limit: args?.limit });
        return {
          content: text([`${args.path}  ${r.start + 1}-${r.start + r.shown} / 共 ${r.total} 行`, '', ...r.lines].join('\n')),
        };
      },
    },
  ];

  const disposeFns = [];
  ctx.effect(() => {
    for (const def of tools) {
      if (ctx.tools.get?.(def.name) !== undefined) {
        logger.warn?.(`${def.name} 已存在，跳过注册`);
        continue;
      }
      try {
        disposeFns.push(ctx.tools.register(def));
      } catch (error) {
        logger.warn?.(`注册 ${def.name} 失败：${error?.message ?? error}`);
      }
    }
    logger.info?.(`aosp: 注册 ${disposeFns.length} 个工具，源码目录 ${rootDir}`);
    return () => {
      for (const dispose of disposeFns.splice(0)) {
        try { dispose(); } catch {}
      }
    };
  }, 'aosp.tools');

  // 会写盘的工具（fetch / update）走审批
  const WRITE_TOOLS = new Set(['aosp_fetch', 'aosp_update', 'aosp_preset']);
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (!WRITE_TOOLS.has(exec.name) || decision?.kind !== 'allow') return decision;
    let argsText = '';
    try { argsText = JSON.stringify(exec.arguments ?? {}); } catch {}
    if (argsText.length > 300) argsText = argsText.slice(0, 300) + '…';
    return { kind: 'ask', reason: `${exec.name} 要动本机源码目录（下载/解包/改写，可达数百 MB）：${argsText}` };
  });
}
