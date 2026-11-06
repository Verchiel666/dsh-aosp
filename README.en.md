# dsh-aosp

**Read AOSP source on an Android phone — no root, no git binary, no compiler.**

This is a [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) host-side plugin. It downloads
AOSP module snapshots, unpacks them locally, and gives the agent ripgrep-based search/read/trace tools.

## Why this route

On the test device (HONOR BKQ-AN20, Android 17, arm64, non-root):

- `github.com` is unreachable, but `codeload.github.com` and `api.github.com` work;
- the popular Chinese AOSP git mirror stalls on `git fetch` (progress freezes at ~119 KB; HTTP/1.1, no `Expect`, and
  plain HTTP were all tried);
- there is no `python`, so `repo` cannot run at all;
- there is no compiler/IDE, so no language server either.

So the plugin uses **tar snapshots + system `tar` + `ripgrep`**, and keeps a small commit-sha cache for incremental updates.

## Tools

| Tool | Risk | What it does |
|---|---|---|
| `aosp_mirror` | read | List the 100 repos in the `aosp-mirror` org (size + last push) — check whether a project is even available |
| `aosp_preset` | write | Fetch a named group: `mini` (system/core + bionic, ~73 MB), `apps`, `framework`, `core` (~1.9 GB) |
| `aosp_fetch` | write | Download + unpack one project; `ref` accepts a branch or a tag such as `android-14.0.0_r1` |
| `aosp_search` | read | ripgrep, flat result list |
| `aosp_grep` | read | ripgrep, results **grouped by module** ("where does this symbol live?") |
| `aosp_trace` | read | Heuristic call chain: callees / callers (callers climb to the enclosing function), 1–3 levels |
| `aosp_read` | read | Read a file by line range (numbered, ≤400 lines) |
| `aosp_update` | write | Incremental update: compare commits, download only changed files |
| `aosp_list` | read | List landed modules from the cached metadata (milliseconds) |

`aosp_fetch` / `aosp_preset` / `aosp_update` ask for approval before touching the source directory.

## Quick start

```
aosp_preset {"name":"mini"}                                   # ~73 MB
aosp_grep   {"pattern":"class ActivityManagerService","glob":"*.java"}
aosp_trace  {"symbol":"attachApplicationLocked","direction":"both","depth":2}
aosp_read   {"path":"frameworks_base/services/core/java/com/android/server/am/ActivityManagerService.java","offset":4500,"limit":40}
```

## How incremental updates work

`aosp_fetch` resolves the ref to a commit sha first, downloads **by sha**, and records it in `<root>/.dsh-aosp.json`.
`aosp_update` then compares the recorded sha with the remote HEAD and, when they differ, pulls only the changed files
via jsDelivr (`gh/aosp-mirror/<repo>@<sha>/<path>`). More than 300 changed files (the GitHub compare limit) falls back
to a full re-download.

## Measured on the device

| Item | Value |
|---|---|
| Download throughput | ~24 MB/s |
| `packages/apps/Settings` | 146 MB / 16.5 s → unpack 2.1 s, 8,087 files |
| `frameworks/base` | 1,713 MB / 69.5 s → unpack **551 s**, 56,733 files |
| `aosp_trace` single layer | 281 ms – 3.1 s |
| `aosp_list` (cached) | 14–17 ms |

Unpacking is the bottleneck and scales with **file count**, not bytes — that is why the tar timeout is 30 minutes.

## Limits

- The mirror mirrors ~100 repos and was last pushed 2025-11-12 (≈ Android 15/16), so it lags current Android;
- `frameworks/native` (the native binder implementation) is **not** in the mirror;
- the tracer is text-based: overloads match by name, reflection/macros are invisible, braces inside strings can
  confuse block extraction. It answers "roughly who is on this path", not a precise call graph;
- this plugin only reads source. Building or flashing AOSP needs an x86_64 Linux host with 400 GB disk and an
  unlockable bootloader — neither is available here.

## Test

```sh
node dev/test.mjs                  # 28 offline assertions
DSH_AOSP_NET=1 node dev/test.mjs   # 33 with real network (download, sha capture, real incremental update)
node ../host-test/rt-aosp.mjs      # 12 against the engine's real cordis 4.0.5
```

## Install

Install through the DSH plugin manager **with a version** (`dsh-aosp@0.2.0`): uninstall the old one, restart the
engine, install, restart again.

MIT
