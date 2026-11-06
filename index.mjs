// dsh-aosp — 在 DSH 里直接拉 AOSP 源码并在本机搜代码（无需 root、无需 git）
//
// 背景：本机 github.com 不通、AOSP 国内 git 镜像的 fetch 会卡死（实测停在 119 KB）；
// 但 codeload.github.com 可达，aosp-mirror 组织镜像了 AOSP 主要项目，
// 所以走「tar 快照 → 系统 tar 解包 → rg 搜索」这条路。
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  fetchProject, listModules, search, grepByModule, readModuleFile, defaultRgPath, repoFor, updateModule,
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
  const WRITE_TOOLS = new Set(['aosp_fetch', 'aosp_update']);
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (!WRITE_TOOLS.has(exec.name) || decision?.kind !== 'allow') return decision;
    let argsText = '';
    try { argsText = JSON.stringify(exec.arguments ?? {}); } catch {}
    if (argsText.length > 300) argsText = argsText.slice(0, 300) + '…';
    return { kind: 'ask', reason: `aosp_${exec.name === 'aosp_fetch' ? 'fetch 要往本机下载并解包 AOSP 源码（可达数百 MB）' : 'update 要按远端 commit 改写本地源码文件'}：${argsText}` };
  });
}
