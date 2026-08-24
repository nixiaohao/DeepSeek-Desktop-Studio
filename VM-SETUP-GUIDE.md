# DeepSeek Studio Linux VM 修复操作指引

## 问题根因

VM 上的 workspace 目录 (`~/.config/deepseek-studio/workspace/deepseek-harness`) 存在两个问题：

1. **stale `.git/shallow.lock`**：之前崩溃的 git fetch 残留了锁文件，阻止所有后续 git 操作
2. **旧/不一致的克隆**：该克隆 predates `packages/api/remotes/` 的添加，导致 tsdown 扫描不到 `@deepseek-ai/dsh-api-remotes`

## 解决方案

用 Windows 上一致源码打的 ZIP 替换 VM 上的旧 workspace。ZIP 包含 9071 个文件（18MB），涵盖完整 harness 源码（含 `packages/api/remotes/`）。

## 操作步骤

### 1. 将 ZIP 拷贝到 VM

将 `harness-source.zip`（18MB）拷贝到 VM（共享文件夹 / SCP / USB 均可）。

### 2. 删除旧 workspace 并解压新源码

在 VM 终端执行：

```bash
# 删除旧的不一致 workspace（含 stale lock）
rm -rf ~/.config/deepseek-studio/workspace/deepseek-harness

# 创建空目录
mkdir -p ~/.config/deepseek-studio/workspace/deepseek-harness

# 解压 ZIP 到 workspace 目录
# 如果没有 unzip：sudo apt install -y unzip
unzip /path/to/harness-source.zip -d ~/.config/deepseek-studio/workspace/deepseek-harness

# 验证关键文件存在
ls ~/.config/deepseek-studio/workspace/deepseek-harness/package.json
ls ~/.config/deepseek-studio/workspace/deepseek-harness/pnpm-workspace.yaml
ls ~/.config/deepseek-studio/workspace/deepseek-harness/packages/api/remotes/package.json
```

### 3. 运行新 AppImage

```bash
# 给新包执行权限
chmod +x "DeepSeek Studio-0.1.0-linux-x86_64.AppImage"

# 直接运行（新包已内置 --no-sandbox，无需手动加参数）
"./DeepSeek Studio-0.1.0-linux-x86_64.AppImage"
```

### 4. 预期行为

AppImage 启动后会：

1. **检测到 workspace 有源码但无 .git** → 尝试 gitify（git init + fetch）→ fetch 失败（VM 连不上 GitHub）→ 跳过，不影响使用
2. **检测到无 node_modules** → 自动安装依赖（需 VM 可达 npm registry）
   - 内置 pnpm 会自动注入 `unrun`（tsdown 的 optional peer）到 `package.json`
   - 执行 `pnpm install --prefer-offline`
3. **检测到未构建** → 执行 `scripts/build.ts`（tsdown 构建）
   - tsdown 的 `workspaceManifest()` 扫描 `packages/*/*/package.json`
   - 找到 `@deepseek-ai/dsh-api-remotes` ✓（ZIP 源码一致）
4. **启动后端服务** → 等待就绪 → 显示主窗口

首次启动需要几分钟（安装 + 构建）。后续启动会跳过安装和构建（已缓存）。

### 5. 如果出错

- **缺库**：`sudo apt install -y libfuse2t64 libnss3 libgbm1 libasound2t64 libgtk-3-0t64 libxshmfence1`
- **npm install 失败**：检查 VM 网络是否能访问 `registry.npmjs.org` 或 `registry.npmmirror.com`
- **查看日志**：`~/.config/deepseek-studio/logs/`（launcher.log / wizard.log / backend.log）

## 新 AppImage 改进（vs 旧包）

- ✅ **stale lock 自愈**：git fetch 前自动清理 `.git/shallow.lock`，防止锁文件永久阻塞
- ✅ **unrun 自愈**：自动注入 `unrun` 到 workspace `package.json`，无需手动操作
- ✅ **no-sandbox wrapper**：AppImage 内 ELF 被 shell wrapper 替换，自动带 `--no-sandbox --disable-setuid-sandbox`
- ✅ **多尺寸图标**：16/32/48/64/128/256px PNG 内置于 AppImage
