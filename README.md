# dsh-aosp

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
| `aosp_list` | 只读 | 列出已落地的模块（大小/文件数/来源 ref） |
| `aosp_fetch` | 写盘 | 下载并解包一个项目；`ref` 可用分支或 tag（如 `android-14.0.0_r1`） |
| `aosp_search` | 只读 | 用 ripgrep 在已落地源码里搜正则（可限定 `*.java`、带上下文） |
| `aosp_grep` | 只读 | 跨模块正则：一次 rg，结果**按模块聚合**（"这东西在哪几个模块出现"） |
| `aosp_read` | 只读 | 按行读源码文件（带行号，最多 400 行） |

`aosp_fetch` 会走审批（写盘 + 可能几百 MB）。

## 用法

```
aosp_fetch   {"project":"frameworks/base"}
aosp_fetch   {"project":"packages/apps/Settings","ref":"android-14.0.0_r1"}
aosp_search  {"pattern":"class ActivityManagerService","glob":"*.java"}
aosp_grep    {"pattern":"zygote_socket","maxPerModule":3}          # 按模块聚合
aosp_grep    {"pattern":"IPCThreadState","glob":"*.cpp","modules":["system_core"]}
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

## 已知边界

- 镜像停在 2025-11-12（≈ Android 15/16），与最新 Android 有漂移；
- 只有 100 个仓，`frameworks/native`（libbinder 原生实现）不在其中；
- 只读源码，不编译（AOSP 编译要求 x86_64 Linux + 400 GB 磁盘 + 64 GB 内存）。

## 测试

```sh
node dev/test.mjs                 # 18 项离线
DSH_AOSP_NET=1 node dev/test.mjs  # 19 项，含一次真下载（external/zlib）
node ../host-test/rt-aosp.mjs     # 10 项：引擎真 cordis 4.0.5 冒烟
```

MIT
