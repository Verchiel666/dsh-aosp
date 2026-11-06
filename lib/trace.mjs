// lib/trace.mjs —— 启发式调用链追踪（只靠 rg + 花括号配对，不跑编译器）
//
// 边界（输出里也会写）：字符串/注释里的括号可能干扰配对；重载只按名字匹配；
// 宏/模板/反射调用看不到。它回答的是"这个函数大概都动了谁/被谁动"，不是精确调用图。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runShell, safeJoin } from './aosp.mjs';

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'new', 'delete', 'throw', 'else', 'do',
  'synchronized', 'assert', 'super', 'this', 'try', 'finally', 'using', 'typeof', 'alignof', 'decltype',
  'static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast', 'defined', 'template', 'operator', 'function',
]);

const MAX_BLOCK_LINES = 400;

/** 在一行里找出被调用的标识符（后跟左括号） */
export function calleesInText(text) {
  const names = new Set();
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const n = m[1];
    if (!KEYWORDS.has(n) && n.length > 2) names.add(n);
  }
  return [...names];
}

/** 从起点行往后找平衡的 {...} 块（粗略忽略括号字符串，够用） */
export function extractBlock(lines, startIdx, maxLines = MAX_BLOCK_LINES) {
  let depth = 0, started = false;
  const out = [];
  for (let i = startIdx; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth <= 0) return out.join('\n'); }
    }
    if (started && depth <= 0) return out.join('\n');
  }
  return out.join('\n');
}

/** 找符号定义：返回 {file, line, kind} 列表（class/interface 或函数式声明） */
export async function findDefinitions({ root, symbol, rgPath, glob = '*', limit = 5, excludeTests = true }) {
  const exclude = excludeTests ? ['-g', '!**/tests/**', '-g', '!**/test/**', '-g', '!**/androidTest/**'] : [];
  const esc = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(class|interface|enum|struct|void|int|bool|boolean|long|float|double|char|auto|[A-Za-z_][\\w<>\\[\\],:*&\\s]*)\\s+${esc}\\s*\\(`;
  const r = await runShell(rgPath, ['-n', '--no-messages', '--color', 'never', '--no-heading', '-g', glob, ...exclude, '--', pattern, root], { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const defs = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const body = m[3].trim();
    if (/^\s*(return|if|while|for|case|assert|log|ALOG|printf|NSLog)\b/.test(body)) continue;
    if (/[;]\s*$/.test(body) && !/\)\s*(const)?\s*(;|,)/.test(body)) continue;
    defs.push({ file: m[1].replace(root + '/', ''), line: Number(m[2]), text: body.slice(0, 140) });
    if (defs.length >= limit) break;
  }
  return defs;
}

/** 找调用点（排除定义行本身） */
export async function findCallers({ root, symbol, rgPath, glob = '*', limit = 8, excludeTests = true }) {
  const exclude = excludeTests ? ['-g', '!**/tests/**', '-g', '!**/test/**', '-g', '!**/androidTest/**'] : [];
  const esc = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const r = await runShell(rgPath, ['-n', '--no-messages', '--color', 'never', '--no-heading', '-g', glob, ...exclude, '--', `\\b${esc}\\s*\\(`, root], { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const hits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const body = m[3].trim();
    // 定义行通常是 "返回类型 名字(" 且不以 . 或 -> 调用
    if (new RegExp(`^[A-Za-z_][\\w<>\\[\\],:*&\\s]*\\b${esc}\\s*\\(`).test(body)) continue;
    hits.push({ file: m[1].replace(root + '/', ''), line: Number(m[2]), text: body.slice(0, 140) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 读某文件的某一行往前/后取块 */
export function blockAt({ root, file, line }) {
  const abs = safeJoin(root, file, '文件路径');
  if (!existsSync(abs)) throw new Error(`文件不存在：${file}`);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const idx = Math.max(0, line - 1);
  const block = extractBlock(lines, idx);
  return { block, lines: block.split('\n').length };
}

/** 这个符号出现在多少个文件里（>阈值就当作通用名字，不展开） */
export async function usageFileCount({ root, symbol, rgPath, glob = '*' }) {
  const esc = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\/** 主入口：按方向逐层展开 */');
  const r = await runShell(rgPath, ['-l', '--no-messages', '-g', glob, '--', `\\b${esc}\\s*\\(`, root], { timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return r.stdout.split('\n').filter(Boolean).length;
}

/** 主入口：按方向逐层展开 */
export async function trace({ root, symbol, rgPath, depth = 2, direction = 'callees', maxPerLevel = 5, glob = '*', includeTests = false, maxUsageFiles = 8 }) {
  const clean = symbol.split(/[.(]/).pop();
  const levels = [];
  const seen = new Set([clean]);
  let frontier = [clean];

  const defs0 = await findDefinitions({ root, symbol: clean, rgPath, glob, limit: maxPerLevel, excludeTests: !includeTests });
  levels.push({ level: 0, symbol: clean, kind: 'definition', nodes: defs0 });

  for (let d = 1; d <= Math.min(Math.max(depth, 1), 3); d++) {
    const nodes = [];
    const next = [];
    for (const sym of frontier) {
      const defs = await findDefinitions({ root, symbol: sym, rgPath, glob, limit: 2, excludeTests: !includeTests });
      for (const def of defs) {
        const { block } = blockAt({ root, file: def.file, line: def.line });
        if (direction === 'callees' || direction === 'both') {
          const callees = calleesInText(block).slice(0, maxPerLevel);
          for (const c of callees) {
            if (seen.has(c)) continue;
            nodes.push({ from: sym, via: `${def.file}:${def.line}`, symbol: c, kind: 'callee' });
          }
        }
      }
      if (direction === 'callers' || direction === 'both') {
        const callers = await findCallers({ root, symbol: sym, rgPath, glob, limit: maxPerLevel, excludeTests: !includeTests });
        for (const c of callers) nodes.push({ from: sym, via: `${c.file}:${c.line}`, symbol: c.text.slice(0, 80), kind: 'caller' });
      }
    }
    for (const n of nodes) {
      if (n.kind === 'callee' && !seen.has(n.symbol)) { seen.add(n.symbol); next.push(n.symbol); }
    }
    levels.push({ level: d, nodes });
    // 只往下钻"不太通用"的名字：出现在 <= maxUsageFiles 个文件里
    const expandable = [];
    for (const name of next) {
      if (expandable.length >= maxPerLevel) break;
      const files = await usageFileCount({ root, symbol: name, rgPath, glob });
      if (files <= maxUsageFiles) expandable.push(name);
      else levels[levels.length - 1].nodes.push({ from: name, kind: 'skipped-generic', symbol: name, via: `出现于 ${files} 个文件` });
    }
    frontier = expandable;
    if (!frontier.length) break;
  }
  return { symbol: clean, direction, depth, levels };
}
