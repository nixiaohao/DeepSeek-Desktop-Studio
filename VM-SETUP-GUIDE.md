# DeepSeek Studio Linux VM 操作指引（v3）

## 问题根因

tsdown 的 config loader 默认是 `auto`，在 Electron 捆绑的 Node 上解析为 `unrun`（因为 Electron 的 Node 没有原生 TypeScript 支持）。unrun 把 `tsdown.config.ts` 及其依赖（`tsdown.client.ts`）打包成 `node_modules/.unrun/` 下的临时文件，导致 `import.meta.url` 指向临时文件而非源码——`REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))` 算出错误路径，`workspaceManifest()` 的 glob 扫描返回空数组，找不到 `@deepseek-ai/dsh-api-remotes` 等包。

## 解决方案（纯 shell 层，不动官方源码）

AppImage 在 `buildAll()` 时调用 `createTsdownWrapper()`，覆写 `node_modules/.bin/tsdown` 为一个 wrapper，强制传 `--config-loader tsx`。tsx 的 ESM loader 保留 `import.meta.url`，`REPOSITORY_ROOT` 正确指向 workspace root。

**官方源码零修改**——ZIP 是 git HEAD 原样打包，git pull/fetch 不会冲突。

## 交付物

| 文件 | 说明 |
|------|------|
| `harness-source-official.zip`（19MB） | git HEAD 官方源码，零修改 |
| `DeepSeek Studio-0.1.0-linux-x86_64.AppImage` | 新包，内置 tsdown wrapper 修复 |

## 操作步骤

### 1. 将文件拷贝到 VM

- `harness-source-official.zip`
- `DeepSeek Studio-0.1.0-linux-x86_64.AppImage`（新的）

### 2. 删除旧 workspace 并解压官方源码

```bash
# 彻底删除旧 workspace（含 stale lock、旧 .git、旧 node_modules）
rm -rf ~/.config/deepseek-studio/workspace/deepseek-harness

# 创建空目录
mkdir -p ~/.config/deepseek-studio/workspace/deepseek-harness

# 解压官方 ZIP 到 workspace 目录
# 如果没有 unzip：sudo apt install -y unzip
unzip /path/to/harness-source-official.zip -d ~/.config/deepseek-studio/workspace/deepseek-harness

# 验证关键文件存在
ls ~/.config/deepseek-studio/workspace/deepseek-harness/package.json
ls ~/.config/deepseek-studio/workspace/deepseek-harness/packages/api/remotes/package.json
ls ~/.config/deepseek-studio/workspace/deepseek-harness/packages/client/tsdown.client.ts
```

### 3. 运行新 AppImage

```bash
# 给执行权限
chmod +x "DeepSeek Studio-0.1.0-linux-x86_64.AppImage"

# 直接运行（新包已内置 --no-sandbox，无需手动加参数）
"./DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
```

### 4. 预期行为

AppImage 启动后会：

1. **检测 workspace 有源码但无 .git** → gitify（git init + fetch）→ fetch 失败跳过，不影响
2. **检测无 node_modules** → 自动 pnpm install（需 VM 可达 npm registry）
   - 自动注入 `unrun`（tsdown optional peer）
3. **构建前覆写 tsdown wrapper** → `node_modules/.bin/tsdown` 被替换为带 `--config-loader tsx` 的 wrapper
4. **执行构建** → tsdown 用 tsx loader 加载 config → `import.meta.url` 正确 → `REPOSITORY_ROOT` 正确 → `workspaceManifest()` 正常工作
5. **启动后端服务** → 等待就绪 → 显示主窗口

首次启动需要几分钟（安装 + 构建）。后续启动跳过安装和构建（已缓存）。

### 5. 如果仍出错

- **缺库**：`sudo apt install -y libfuse2t64 libnss3 libgbm1 libasound2t64 libgtk-3-0t64 libxshmfence1`
- **npm install 失败**：检查 VM 网络是否能访问 `registry.npmjs.org` 或 `registry.npmmirror.com`
- **查看日志**：`~/.config/deepseek-studio/logs/`
  - `launcher.log`：启动流程
  - `wizard.log`：安装/构建输出
- **确认 wrapper 生效**：构建前检查 `cat ~/.config/deepseek-studio/workspace/deepseek-harness/node_modules/.bin/tsdown | head -3`，应包含 `--config-loader tsx`

## AppImage 改进（vs 旧包）

- ✅ **tsdown wrapper**：强制 `--config-loader tsx`，绕过 unrun 打包，保留 `import.meta.url`
- ✅ **stale lock 自愈**：git fetch 前自动清理 `.git/shallow.lock`
- ✅ **unrun 自愈**：自动注入 `unrun` 到 workspace `package.json`
- ✅ **no-sandbox wrapper**：AppImage 内 ELF 被 shell wrapper 替换
- ✅ **多尺寸图标**：16/32/48/64/128/256px PNG
- ✅ **官方源码零修改**：ZIP 是 git HEAD 原样，git pull 不冲突
