# DeepSeek Studio Linux VM 操作指引（v7）

## 问题根因（四层，全部 Docker 复现验证）

1. **unrun loader**：tsdown 的 `auto` loader 在无原生 TypeScript 支持的 Node 上解析为 `unrun`。unrun 用 rolldown 把 config 打包成临时文件时，**把 `import.meta.url` 常量折叠成入口 config 的路径**——`tsdown.client.ts` 里的 `REPOSITORY_ROOT = new URL('../..', import.meta.url)` 本该指向仓库根，却被折叠成基于 `packages/api/remotes/tsdown.config.ts` 的 `packages/` → `workspaceManifest()` 找不到包 → `no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-remotes`（v1 最初错误的真正根因）。
2. **tsx loader 也不行**：tsdown 0.22.2 的 `--config-loader tsx` 只能加载根 config；workspace 子包 config 加载路径未被 tsImport 转换，直接报 `SyntaxError: Unexpected identifier 'as'`（Node 20.18 / 22.22 均复现）。
3. **native loader 是唯一正解**：Node ≥22.18 原生支持 TypeScript 剥离（`process.features.typescript === "strip"`），native loader 保留 `import.meta.url`，全部 workspace config 正常加载。
4. **v6 的 bug（本次修复）**：VM 的 Node 22.22.1 是**禁用了类型剥离的构建**（`process.features.typescript === false`，非官方默认行为）。而探测代码 `if (probe)` 判断的是字符串真值——`"false"` 是真字符串！于是错误地强制了 native loader → `ERR_UNKNOWN_FILE_EXTENSION ".ts"`。

## 解决方案（纯 shell 层，不动官方源码）

AppImage 在 `buildAll()` 时调用 `createTsdownWrapper()`，覆写 `node_modules/.bin/tsdown`：

1. **探测构建 Node**：`node -p process.features.typescript`（Electron Node 时带 `ELECTRON_RUN_AS_NODE=1`）。结果显式排除 `"false"` / `"undefined"` / 空串。
2. 有原生 TS → wrapper 强制 `--config-loader native`（与 v6 相同）。
3. **没有原生 TS → 二次探测**：`node --experimental-strip-types -p process.features.typescript`。如果 Node 编译了剥离功能但默认关闭（VM 的情况），wrapper 会带上 `--experimental-strip-types` 并强制 `--config-loader native`。
4. 两者都不行 → 纯透传（auto loader，官方默认行为）。
5. **无条件覆写**——旧版本写入的坏 wrapper 每次构建都会被替换。

**官方源码零修改**——workspace 由 git fetch 更新，git pull/fetch 不会冲突。

## 前置要求

VM 需要 **Node ≥ 22.18 且支持类型剥离**。v7 的 wrapper 会自动尝试 `--experimental-strip-types`，但前提是 Node 二进制里编译了该功能：

```bash
node -v                                              # 应 ≥ v22.18
node -p "process.features.typescript"                # 期望 strip；VM 实际输出 false
node --experimental-strip-types -p "process.features.typescript"   # v7 依赖此命令输出 strip
```

如果最后一条命令输出不是 `strip`（说明 Node 编译时就剥离了该功能），请换官方 Node：
从 https://npmmirror.com/mirrors/node/ 下载 tarball 解压到 PATH，或用 nvm 安装。

## 交付物

| 文件 | 说明 |
|------|------|
| `DeepSeek Studio-0.1.0-linux-x86_64.AppImage` | 新包（v7，strip 探测修复 + flag 回退） |

## 操作步骤

### 1. 将新 AppImage 拷贝到 VM

只需换 AppImage。workspace / node_modules 都不用动——上次失败的构建没有写入成功标记，新 AppImage 会自动重新构建，并覆写掉旧的坏 wrapper。

### 2. 运行新 AppImage

```bash
chmod +x "DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
"./DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
```

### 3. 预期行为

1. 检测到上次构建失败 → 自动重新构建
2. 日志显示 `createTsdownWrapper: node probe features.typescript=false (strip forced via --experimental-strip-types)`
3. wrapper 形如 `exec /usr/bin/node --experimental-strip-types <run.mjs> --config-loader native`
4. tsdown 以 native loader 加载全部 workspace config → `import.meta.url` 正确 → 构建通过
5. 启动后端 → 显示主窗口

### 4. 如果仍出错

- **先手动验证第 3 节的三条命令**（尤其最后一条必须输出 `strip`）
- **确认 wrapper 生效**：`head -3 ~/.config/deepseek-studio/workspace/deepseek-harness/node_modules/.bin/tsdown`，应含 `--experimental-strip-types` 和 `--config-loader native`
- **缺库**：`sudo apt install -y libfuse2t64 libnss3 libgbm1 libasound2t64 libgtk-3-0t64 libxshmfence1`
- **查看日志**：`~/.config/deepseek-studio/logs/`（launcher.log / wizard.log）

## 已在 Docker Linux 验证的内容（v7）

用 `/opt/node-v22.22.1 + --no-experimental-strip-types` 精确模拟 VM 的"22.22.1 但 features.typescript=false"：

- 强制 `--config-loader native`（v6 行为）→ `ERR_UNKNOWN_FILE_EXTENSION ".ts"`（**完全复现 VM 本次日志**）
- auto loader（unrun）→ rolldown 折叠 `import.meta.url` → `REPOSITORY_ROOT` 错到 `packages/` → **dsh-api-remotes 错误复现**（v1 根因实锤）
- 抓取运行中的 unrun bundle，确认折叠结果：`new URL("../..", "file:///…/packages/api/remotes/tsdown.config.ts")`
- **`--experimental-strip-types` + native** → `build:lib:host` exit 0
- **完整构建**（`node --import tsx/esm scripts/build.ts`，与 AppImage 调用方式一致）→ exit 0，200 个 client 产物
