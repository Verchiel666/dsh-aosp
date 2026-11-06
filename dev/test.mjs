// dsh-aosp 自测：离线部分默认跑；需要网络的用 DSH_AOSP_NET=1 打开。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import * as core from '../lib/aosp.mjs';
import * as plugin from '../index.mjs';

let pass = 0; const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name} — ${e.message}`); }
};

console.log('\n项目名映射');
await t('frameworks/base → platform_frameworks_base', () => assert.equal(core.repoFor('frameworks/base'), 'platform_frameworks_base'));
await t('system/core → platform_system_core', () => assert.equal(core.repoFor('system/core'), 'platform_system_core'));
await t('platform/frameworks/base 不再重复前缀', () => assert.equal(core.repoFor('platform/frameworks/base'), 'platform_frameworks_base'));
await t('空项目名报错', () => assert.throws(() => core.repoFor(''), /不能为空/));
await t('非法字符报错', () => assert.throws(() => core.repoFor('a b'), /非法字符/));
await t('目录名把 / 换成 _', () => assert.equal(core.dirNameFor('packages/apps/Settings'), 'packages_apps_Settings'));
await t('tarball 两个候选：heads + tags', () => {
  const [a, b] = core.tarballUrls('bionic', 'android-14.0.0_r1');
  assert.match(a, /refs\/heads\/android-14\.0\.0_r1$/);
  assert.match(b, /refs\/tags\/android-14\.0\.0_r1$/);
  assert.match(a, /aosp-mirror\/platform_bionic/);
});

console.log('\n路径安全');
await t('拒绝 ../ 穿越', () => assert.throws(() => core.safeJoin('/tmp/root', '../etc/passwd'), /越界/));
await t('正常相对路径可解析', () => assert.equal(core.safeJoin('/tmp/root', 'a/b.txt'), '/tmp/root/a/b.txt'));

const root = mkdtempSync(join(tmpdir(), 'dsh-aosp-test-'));
try {
  console.log('\n镜像清单工具（纯函数）');
  await t('repoToPath 推导项目路径', () => {
    assert.equal(core.repoToPath('platform_frameworks_base'), 'frameworks/base');
    assert.equal(core.repoToPath('platform_packages_apps_Settings'), 'packages/apps/Settings');
    assert.equal(core.repoToPath('platform_bionic'), 'bionic');
  });

  await t('filterRepos 按关键词过滤 + 限量', () => {
    const repos = [
      { name: 'platform_frameworks_base', mb: 7898 },
      { name: 'platform_bionic', mb: 54.6 },
      { name: 'platform_system_core', mb: 214 },
    ];
    assert.equal(core.filterRepos(repos, 'framework').length, 1);
    assert.equal(core.filterRepos(repos, 'system/core').length, 1);
    assert.equal(core.filterRepos(repos, '').length, 3);
    assert.equal(core.filterRepos(repos, '', 2).length, 2);
  });

  console.log('\n本地读写');
  mkdirSync(join(root, 'frameworks_base', 'core'), { recursive: true });
  writeFileSync(join(root, 'frameworks_base', 'core', 'Build.java'),
    'public class Build {\n  public static final int VANILLA_ICE_CREAM = 35;\n}\n');
  writeFileSync(join(root, 'frameworks_base', 'Android.bp'), 'cc_library { name: "build_test" }\n');

  await t('listModules 统计目录与文件数', async () => {
    const { modules } = core.listModules(root);
    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, 'frameworks_base');
    assert.equal(modules[0].files, 2);
    assert.ok(modules[0].bytes > 0);
  });

  await t('listModules 用 meta 里的缓存数（不重扫）', () => {
    const meta = core.readMeta(root);
    meta.modules.frameworks_base = { ...(meta.modules.frameworks_base || {}), files: 999, bytes: 123, project: 'frameworks/base' };
    core.writeMeta(root, meta);
    const { modules } = core.listModules(root);
    const fb = modules.find((m) => m.name === 'frameworks_base');
    assert.equal(fb.files, 999, '应直接用缓存里的 999');
    assert.equal(fb.bytes, 123);
  });

  await t('listModules refresh:true 会重新统计', () => {
    const { modules } = core.listModules(root, { refresh: true });
    const fb = modules.find((m) => m.name === 'frameworks_base');
    assert.equal(fb.files, 2, '真实就是 2 个文件');
    assert.ok(fb.bytes > 0);
  });

  await t('readModuleFile 带行号 + 分页', () => {
    const r = core.readModuleFile({ root, path: 'frameworks_base/core/Build.java', offset: 2, limit: 1 });
    assert.equal(r.total, 3);
    assert.match(r.lines[0], /^\s+2\s+public static final int VANILLA_ICE_CREAM/);
  });

  await t('readModuleFile 拒绝越界路径', () => {
    assert.throws(() => core.readModuleFile({ root, path: '../../etc/hosts' }), /越界/);
  });

  await t('search 在本地树里命中', async () => {
    const r = await core.search({ root, pattern: 'VANILLA_ICE_CREAM', rgPath: core.defaultRgPath(homedir()) });
    assert.equal(r.total, 1);
    assert.match(r.hits[0], /frameworks_base\/core\/Build\.java:2:/);
  });

  await t('search 无命中返回空而不是报错', async () => {
    const r = await core.search({ root, pattern: 'NO_SUCH_SYMBOL_XYZ', rgPath: core.defaultRgPath(homedir()) });
    assert.equal(r.total, 0);
  });

  await t('grepByModule 按模块聚合', async () => {
    mkdirSync(join(root, 'system_core', 'init'), { recursive: true });
    writeFileSync(join(root, 'system_core', 'init', 'service.cpp'), '// zygote_socket ref\n');
    const r = await core.grepByModule({ root, pattern: 'zygote_socket', rgPath: core.defaultRgPath(homedir()), maxPerModule: 2 });
    assert.equal(r.total, 1);
    assert.equal(r.modules[0].name, 'system_core');
    assert.match(r.modules[0].hits[0], /system_core\/init\/service\.cpp:1:/);
  });

  await t('grepByModule 支持 modules 过滤', async () => {
    const r = await core.grepByModule({ root, pattern: 'zygote_socket', rgPath: core.defaultRgPath(homedir()), modules: ['frameworks_base'] });
    assert.equal(r.total, 0);
  });

  console.log('\n预设包');
  await t('预设包定义完整（名称/描述/模块）', () => {
    const ps = core.describePresets();
    assert.ok(ps.length >= 4);
    for (const p of ps) {
      assert.ok(p.name && p.desc && p.modules.length >= 1);
      assert.ok(core.PRESETS[p.name].modules.every(([proj]) => typeof proj === 'string'));
    }
    assert.ok(ps.some((p) => p.name === 'mini'));
  });

  await t('未知预设报错清楚', async () => {
    await assert.rejects(() => core.fetchPreset({ name: 'nope', root }), /没有这个预设/);
  });

  await t('fetchPreset 对已存在的模块全部跳过（不打网络）', async () => {
    mkdirSync(join(root, 'system_core'), { recursive: true });
    mkdirSync(join(root, 'bionic'), { recursive: true });
    const r = await core.fetchPreset({ name: 'mini', root });
    assert.equal(r.results.length, 2);
    assert.ok(r.results.every((x) => x.skipped), JSON.stringify(r.results));
  });

  console.log('\n调用链追踪（合成树）');
  await t('trace 能顺着 callees 展开两层', async () => {
    mkdirSync(join(root, 'tr'), { recursive: true });
    writeFileSync(join(root, 'tr', 'A.java'), 'class A {\n  void foo() {\n    bar();\n    baz(1);\n  }\n}\n');
    writeFileSync(join(root, 'tr', 'B.java'), 'class B {\n  void bar() {\n    qux();\n  }\n  void baz(int x) {}\n  void qux() {}\n}\n');
    const tr = await import('../lib/trace.mjs');
    const r = await tr.trace({ root, symbol: 'foo', rgPath: core.defaultRgPath(homedir()), depth: 2, maxPerLevel: 4 });
    const l1 = r.levels[1].nodes.map((n) => n.symbol);
    assert.ok(l1.includes('bar') && l1.includes('baz'), JSON.stringify(l1));
    const l2 = r.levels[2].nodes.map((n) => n.symbol);
    assert.ok(l2.includes('qux'), JSON.stringify(l2));
  });

  await t('trace callers 能找到调用点', async () => {
    const tr = await import('../lib/trace.mjs');
    const r = await tr.trace({ root, symbol: 'bar', rgPath: core.defaultRgPath(homedir()), depth: 1, direction: 'callers' });
    assert.ok(r.levels[1].nodes.length >= 1);
    assert.ok(r.levels[1].nodes.some((n) => n.via.endsWith('A.java:3')), JSON.stringify(r.levels[1].nodes));
  });

  console.log('\n插件契约（假 ctx）');
  await t('apply 注册 9 个工具', async () => {
    const registered = new Map();
    const ctx = {
      logger: () => ({ info() {}, warn() {} }),
      effect: (fn) => { fn(); },
      on: () => {},
      tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name); }, get: (n) => registered.get(n) },
    };
    plugin.apply(ctx, { rootDir: root });
    assert.deepEqual([...registered.keys()].sort(), ['aosp_fetch', 'aosp_grep', 'aosp_list', 'aosp_mirror', 'aosp_preset', 'aosp_read', 'aosp_search', 'aosp_trace', 'aosp_update']);
    const list = await registered.get('aosp_list').execute({});
    assert.match(list.content[0].text, /frameworks_base/);
    const res = await registered.get('aosp_search').execute({ pattern: 'cc_library', glob: '*.bp' });
    assert.match(res.content[0].text, /命中 1 行/);
    const read = await registered.get('aosp_read').execute({ path: 'frameworks_base/Android.bp' });
    assert.match(read.content[0].text, /共 1 行/);
  });

  await t('aosp_fetch 在已存在时跳过（不打网络）', async () => {
    const registered = new Map();
    const ctx = {
      logger: () => ({ info() {}, warn() {} }),
      effect: (fn) => { fn(); }, on: () => {},
      tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name); }, get: (n) => registered.get(n) },
    };
    plugin.apply(ctx, { rootDir: root });
    const r = await registered.get('aosp_fetch').execute({ project: 'frameworks/base' });
    assert.match(r.content[0].text, /已存在，跳过/);
  });

  if (process.env.DSH_AOSP_NET === '1') {
    console.log('\n联网（DSH_AOSP_NET=1）');
    await t('真下载一个小项目 external/zlib', async () => {
      const r = await core.fetchProject({ project: 'external/zlib', root, tarPath: '/system/bin/tar' });
      assert.ok(r.files > 50, `文件数 ${r.files}`);
      assert.ok(r.bytes > 100_000, `字节 ${r.bytes}`);
      const s = await core.search({ root, pattern: 'deflate|inflate', rgPath: core.defaultRgPath(homedir()), maxResults: 5 });
      assert.ok(s.total > 0);
    await t('真拉一次镜像清单（约 100 个仓）', async () => {
      const { repos } = await core.listMirrorRepos({ cacheFile: join(root, '.aosp-mirror.json'), refresh: true });
      assert.ok(repos.length >= 90, '仓数 ' + repos.length);
      assert.ok(repos[0].mb > 100, '最大仓 ' + repos[0].name + ' ' + repos[0].mb);
    });

    await t('fetchProject 把 commit sha 记进 meta', async () => {
      const meta = core.readMeta(root);
      const m = meta.modules['external_zlib'];
      assert.ok(m, '没有 external_zlib 记录');
      assert.match(String(m.sha), /^[0-9a-f]{7,40}$/, 'sha 形如 ' + m.sha);
    });

    await t('没变化的模块 updateModule 判为最新', async () => {
      const r = await core.updateModule({ project: 'external/zlib', root, dest: 'external_zlib' });
      assert.equal(r.upToDate, true);
    });

    await t('把 meta 退回旧 sha 后能真增量更新', async () => {
      const commits = await core.githubJson('/repos/aosp-mirror/platform_external_zlib/commits?per_page=3');
      const older = commits[commits.length - 1].sha;
      const meta = core.readMeta(root);
      const headSha = meta.modules['external_zlib'].sha;
      assert.notEqual(older, headSha, '需要一个更旧的 commit');
      meta.modules['external_zlib'].sha = older;
      core.writeMeta(root, meta);
      const r = await core.updateModule({ project: 'external/zlib', root, dest: 'external_zlib' });
      assert.equal(r.updated, true, JSON.stringify(r).slice(0, 200));
      assert.equal(r.sha, headSha, '更新后应回到远端 HEAD');
      assert.ok(r.changed >= 1);
      assert.ok(r.written >= 1);
    });


    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项：${fails.join(' / ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
