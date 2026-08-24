# DeepSeek Studio Linux VM 操作指引（v4）

## 问题根因（三层，均已 Docker 复现验证）

1. **unrun loader**：tsdown 的 `auto` loader 在无原生 TypeScript 支持的 Node（如 Electron 33 内置的 Node 20.18）上解析为 `unrun`。unrun 把 config 打包成临时文件，`import.meta.url` 失真 → `REPOSITORY_ROOT` 算错 → `workspaceManifest()` 找不到包。
2. **tsx loader 也不行**：tsdown 0.22.2 的 `--config-loader tsx` 只能加载根 config；workspace 子包 config 加载路径未被 tsImport 转换，直接报 `SyntaxError: Unexpected identifier 'as'`（Node 20.18 / 22.22 均复现）。
3. **native loader 是唯一正解**：Node ≥22.18 原生支持 TypeScript 剥离（`process.features.typescript === "strip"`），native loader 保留 `import.meta.url`，全部 workspace config 正常加载。

## 解决方案（纯 shell 层，不动官方源码）

AppImage 在 `buildAll()` 时调用 `createTsdownWrapper()`，覆写 `node_modules/.bin/tsdown`：

- **探测构建 Node**（`node -p process.features.typescript`，Electron Node 时带 `ELECTRON_RUN_AS_NODE=1`）
- 有原生 TS → wrapper 强制 `--config-loader native`
- 没有 → wrapper 纯透传（auto loader，官方默认行为）
- **无条件覆写**——旧版本 AppImage 写入的坏 wrapper（强制 tsx）每次构建都会被替换掉

**官方源码零修改**——ZIP 是 git HEAD 原样打包，git pull/fetch 不会冲突。

## 前置要求

VM 需要 **Node ≥ 22.18**（本仓库 engines 本来就要求 `^22.19 || >=24`）：

```bash
node -v          # 应 ≥ v22.18（例如 v22.22.1）
node -p "process.features.typescript"   # 应输出 strip
```

如果 VM 没装或版本太旧：`sudo apt install -y nodejs`（Ubuntu 24.04+ 官方源即为 Node 22.x），或从 https://npmmirror.com/mirrors/node/ 下载 tarball 解压到 PATH。

## 交付物

| 文件 | 说明 |
|------|------|
| `harness-source-official.zip`（19MB） | git HEAD 官方源码，零修改（与之前相同，无需重拷） |
| `DeepSeek Studio-0.1.0-linux-x86_64.AppImage` | 新包（v4，native loader wrapper） |

## 操作步骤

### 1. 将新 AppImage 拷贝到 VM

只需换 AppImage。workspace / ZIP / node_modules 都不用动——上次失败的构建没有写入成功标记，新 AppImage 会自动重新构建，并覆写掉旧的坏 wrapper。

### 2. 运行新 AppImage

```bash
chmod +x "DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
"./DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
```

### 3. 预期行为

1. 检测到上次构建失败 → 自动重新构建
2. 覆写 `node_modules/.bin/tsdown` 为 native loader wrapper（日志显示 `createTsdownWrapper: node probe features.typescript=strip`）
3. tsdown 以 native loader 加载全部 workspace config → `import.meta.url` 正确 → 构建通过
4. 启动后端 → 显示主窗口

### 4. 如果仍出错

- **确认 Node 版本**：`node -v` ≥ 22.18（见"前置要求"）
- **确认 wrapper 生效**：`head -3 ~/.config/deepseek-studio/workspace/deepseek-harness/node_modules/.bin/tsdown`，末尾应含 `--config-loader native`
- **缺库**：`sudo apt install -y libfuse2t64 libnss3 libgbm1 libasound2t64 libgtk-3-0t64 libxshmfence1`
- **查看日志**：`~/.config/deepseek-studio/logs/`（launcher.log / wizard.log）

## 已在 Docker Linux 验证的内容

- Node 22.22.1（与 VM 完全一致）+ 官方 ZIP 源码 + pnpm 11.7.0：
  - tsx loader → `SyntaxError: Unexpected identifier 'as'`（复现 VM 失败）
  - auto / native loader → 全部 config 加载成功
  - **完整构建**（`node --import tsx/esm scripts/build.ts`，与 AppImage 调用方式一致）→ exit 0，200 个 client 产物
  - **经 wrapper（`--config-loader native` + NODE_PATH）完整构建** → exit 0
