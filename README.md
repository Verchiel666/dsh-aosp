# dsh-aosp

[![npm](https://img.shields.io/npm/v/dsh-aosp.svg)](https://www.npmjs.com/package/dsh-aosp)
[![license](https://img.shields.io/npm/l/dsh-aosp.svg)](LICENSE)

`npm i dsh-aosp` · [GitHub](https://github.com/Verchiel666/dsh-aosp) · [Issues](https://github.com/Verchiel666/dsh-aosp/issues)

在 DSH 里直接**拉 AOSP 源码快照，并在手机上搜代码**——不需要 root、不需要 git、不编译。

## 为什么是这条路

这台手机上：

- `github.com` 不通（`api.github.com` / `codeload.github.com` 通）；
- AOSP 的国内 git 镜像（如中科大）`git fetch` 会卡死（实测进度恒停在 119 KB）；
- 没有 python，所以 `repo` 用不了。

但 `codeload.github.com` 可达，GitHub 的 `aosp-mirror` 组织镜像了 AOSP 主要项目（frameworks/base、
packages/apps/*、system/core、bionic、build、external/* 等 100 个仓）。于是走
**tar 快照 → 系统 tar 解包 → ripgrep 搜索**，实测 3–12 MB/s，`packages/apps/Settings` 46 MB / 7 秒。

## 工具

| 工具 | 风险 | 作用 |
|---|---|---|
| `aosp_list` | 只读 | 列出已落地的模块（大小/文件数/ref/sha）。**默认用缓存**，`refresh:true` 才重扫 |
| `aosp_fetch` | 写盘 | 下载并解包一个项目；`ref` 可用分支或 tag（如 `android-14.0.0_r1`） |
| `aosp_search` | 只读 | 用 ripgrep 在已落地源码里搜正则（可限定 `*.java`、带上下文） |
| `aosp_grep` | 只读 | 跨模块正则：一次 rg，结果**按模块聚合**（"这东西在哪几个模块出现"） |
| `aosp_update` | 写盘 | **增量更新**：比对远端 commit，只改动的文件（新增/修改/删除/改名） |
| `aosp_trace` | 只读 | 启发式调用链：给函数名，顺「它调了谁」或「**谁调了它（会爬上外层函数）**」钻 1–3 层；通用名自动不展开 |
| `aosp_read` | 只读 | 按行读源码文件（带行号，最多 400 行） |

`aosp_fetch` 会走审批（写盘 + 可能几百 MB）。

## 用法

```
aosp_fetch   {"project":"frameworks/base"}
aosp_fetch   {"project":"packages/apps/Settings","ref":"android-14.0.0_r1"}
aosp_search  {"pattern":"class ActivityManagerService","glob":"*.java"}
aosp_grep    {"pattern":"zygote_socket","maxPerModule":3}          # 按模块聚合
aosp_grep    {"pattern":"IPCThreadState","glob":"*.cpp","modules":["system_core"]}
aosp_update  {"module":"frameworks_base"}        # 增量更新（只下改动文件）
aosp_trace   {"symbol":"attachApplicationLocked","direction":"both","depth":2}
aosp_read    {"path":"frameworks_base/services/core/java/com/android/server/am/ActivityManagerService.java","offset":520,"limit":40}
```

默认落地目录 `$HOME/work/aosp-src`（和手工那份共用），可用 `rootDir` 改。

## 配置

```yaml
- insert:
    - id: aosp
      name: dsh-aosp
      config:
        rootDir: ''   # 默认 $HOME/work/aosp-src
        rgPath: ''    # 默认 App 自带 bin/rg
```

## 增量更新怎么工作

`aosp_fetch` 会先解析 ref 的 commit sha，**按 sha 下包**（保证包内容与记录一致），并把 sha 写进
`<root>/.dsh-aosp.json`。`aosp_update` 之后：

1. 查远端 HEAD sha，一样就直接返回"已是最新"（零下载）；
2. 不一样就调 GitHub compare API 拿改动清单；
3. 对每个文件：删除的直接删，新增/修改/改名用 **jsDelivr**（`gcore.jsdelivr.net/gh/aosp-mirror/<repo>@<sha>/<path>`）
   按 commit 取单文件，不需要重下整包；
4. 改动文件数超过上限（默认 300，正是 GitHub compare 的上限）→ 提示改用 `aosp_fetch force:true` 整包重下。

注意：老版本落的模块（meta 里没有 sha）不能增量，会明确提示重下一次。

**性能**：`aosp_list` 默认读 `.dsh-aosp.json` 里的缓存计数（**14 ms**）；强制重扫 56k 个文件要好几分钟，
只有加 `refresh:true` 才会重扫。

**耗时实测**（本机）：下载 24 MB/s 左右；解包 `frameworks/base`（56,733 文件 / 1.8 GB）要 **551 秒**，
而 `packages/apps/Settings`（8,087 文件）只要 2.1 秒 —— **小文件越多、解包越慢**，tar 超时因此设成 30 分钟，
下载失败会自动重试 3 次。

## 已知边界

- 镜像停在 2025-11-12（≈ Android 15/16），与最新 Android 有漂移；
- 只有 100 个仓，`frameworks/native`（libbinder 原生实现）不在其中；
- 只读源码，不编译（AOSP 编译要求 x86_64 Linux + 400 GB 磁盘 + 64 GB 内存）。

## 测试

```sh
node dev/test.mjs                 # 18 项离线
DSH_AOSP_NET=1 node dev/test.mjs  # 22 项，含真下载 + 真增量更新（回退 sha 再更新）
node ../host-test/rt-aosp.mjs     # 12 项：引擎真 cordis 4.0.5 冒烟
```

MIT
