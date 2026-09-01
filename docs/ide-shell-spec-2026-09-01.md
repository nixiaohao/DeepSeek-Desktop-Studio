# DeepSeek Studio 壳增强实施规格（Codex 式体验 + 健康监控）

> 日期：2026-09-01
> 前置：《[IDE 方向可行性分析](./ide-feasibility-2026-09-01.md)》
> 定位：**不做重量型 IDE**。本项目是 dsh 的「高级扩展壳」——用 Electron 提供 dsh 自身没有的
> 桌面基建（进程监控、面板、状态栏、外部编辑器桥接、文件查看），智能体能力全部复用 dsh。

---

## 0. 定位与边界（先立规矩）

| 归 dsh（不碰、不重写） | 归本壳（Electron 主场） |
|---|---|
| 会话/对话流、工具调用渲染 | 后端进程健康监控与告警 |
| `DiffCallView` 变更数据、审批语义 | 面板容器、布局、splitter、状态栏 |
| SSE 事件流、权限请求 | 菜单、快捷键、偏好持久化 |
| 前端资产（React + CodeMirror + shiki） | 外部编辑器桥接、文件路径识别与查看 |

**决定性约束（来自可行性分析，不可违背）**：代码只能落在 `shell/` 仓内。
任何需要把文件放进 dsh workspace 的方案（如 `ui-slots` 插件注入）都会被自动更新的
`git reset --hard` 抹掉 —— 已否，勿复用。

---

## 1. 总体布局

```
┌──────────────────────────────┬───────────────────────┐
│                              │  右栏（可开关 / 可调宽）│
│   dsh web 主内容             │ ┌───────────────────┐ │
│   （现有 loadURL，不动）      │ │ 变更审阅区（阶段二）│ │
│                              │ ├─────── splitter ──┤ │ ← 拖拽调高
│                              │ │ 监控面板 ← 本次重点│ │
│                              │ └───────────────────┘ │
├──────────────────────────────┴───────────────────────┤
│ 状态栏：● 健康 / 版本 / 端口 / 通道 / 错误数 / 重启按钮│  24px
└──────────────────────────────────────────────────────┘
```

三个视图彼此独立（见 §2），右栏与状态栏都可经菜单独立开关。

---

## 2. 核心架构决策：WebContentsView 叠加，绝不注入 DOM

### 为什么

- 主内容是**远程 localhost 页面**（`dsh web`），不是我们的资产。注入 DOM / CSS 会随上游
  前端更新而失效，且要读它的内部选择器，等于反向依赖上游实现细节。
- `contextIsolation: true`（`src/main.ts:129`）—— 页面内拿不到 Node，注入脚本能力受限。
- 叠加方案是 Electron 层合成，dsh 前端怎么改都不影响我们。

### 怎么做（Electron 33.4.11，`WebContentsView` 可用）

`BrowserWindow.contentView` 在 Electron 30+ 已可用，主 `webContents` 以子视图形式存在。

```ts
// window-manager.ts（新增）
const panelView = new WebContentsView({
  webPreferences: { preload: join(__dirname, 'panel-preload.js'),
                    contextIsolation: true, nodeIntegration: false },
})
panelView.webContents.loadFile(join(app.getAppPath(), 'assets', 'panel.html'))
win.contentView.addChildView(panelView)
```

布局由主进程在 `resize` / 面板开关 / splitter 拖拽时统一 `setBounds`。

> ⚠️ **实现第一天必须先验证**：`win.contentView.children[0]` 是否即为主 webContents 视图、
> 能否对其 `setBounds` 以缩小主内容区（避免面板遮挡导致 dsh 页面出现横向滚动条）。
> 若不可行，回退方案是改用 `BaseWindow` 显式管理三个 `WebContentsView`。
> 用一个 20 行探针脚本验证，不要凭文档假设。

### 需要新增/改动的文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/window-manager.ts` | 新增 | 视图创建、bounds 计算、resize 订阅、面板显隐 |
| `src/panel-preload.ts` | 新增 | 面板专用 bridge（与主 preload 分开，权限更窄） |
| `src/ipc-registry.ts` | 新增 | IPC 通道集中注册表 + 共享类型，终结 `setupIPC()` 裸写 |
| `src/health-monitor.ts` | 新增 | 健康状态机（§4） |
| `src/external-editor.ts` | 新增 | 外部编辑器探测与拉起（§7） |
| `src/path-links.ts` | 新增 | 输出流中的文件路径识别（§8） |
| `assets/panel.html` | 新增 | 右栏（变更区 + 监控面板 + splitter） |
| `assets/statusbar.html` | 新增 | 底部状态栏 |
| `src/logging.ts` | 改 | backend ring buffer（§3） |
| `src/preferences.ts` | 改 | 面板几何、外部编辑器、面板可见性 |
| `src/menu.ts` | 改 | 视图/设置菜单项 |
| `src/main.ts` | 改 | 挂载 window-manager，收敛 `setupIPC()`（现 552 行） |
| `src/launcher.ts` | 改 | 暴露 `restartBackend()`（§5） |

> `src/main.ts` 已 705 行且仍在膨胀 —— **建议阶段 0 先做架构铺路**（拆 `window-manager`、
> IPC 注册表），否则每加一个面板函数都往 main.ts 里塞。

---

## 3. 监控面板：数据源改造

### 现状盘点（已核对）

`src/launcher.ts:189` `spawnDshWeb()` 已经把后端输出全部接住：

| 行号 | 内容 |
|---|---|
| `launcher.ts:212-215` | `stdout` → `appendChildOutput('backend', '[OUT] …')`，**含 token 脱敏** |
| `launcher.ts:237` | `stderr` → `appendChildOutput('backend', '[ERR] …')` |
| `launcher.ts:238` | `proc.on('exit', code => …)` |
| `launcher.ts:239` | `proc.on('error', err => …)` |

**关键缺口**：`logging.ts:60` 的 `appendChildOutput()` **只 `appendFileSync` 写文件，不进 ring buffer**
——对照同文件 `log()`（`logging.ts:47-51`）会 `ring.push`。
因此 `getRecentLines()`（`logging.ts:69`）**拿不到任何后端输出行**，面板无法用现成接口取数。

### 改造（logging.ts）

```ts
const BACKEND_RING_LIMIT = 500
const backendRing: { ts: number; stream: 'out' | 'err'; line: string }[] = []
const backendSubs = new Set<(e: BackendLineEvent) => void>()

export function appendChildOutput(name: LogName, chunk: string): void {
  /* 现有写文件逻辑保持不变 */
  if (name === 'backend') {
    for (const raw of chunk.split(/\r?\n/)) {
      if (!raw.trim()) continue
      const stream = raw.startsWith('[ERR]') ? 'err' : 'out'
      const e = { ts: Date.now(), stream, line: redactTokenInText(raw) }
      backendRing.push(e); if (backendRing.length > BACKEND_RING_LIMIT) backendRing.shift()
      backendSubs.forEach((cb) => cb(e))   // 实时推送
    }
  }
}
```

**要点**

- **脱敏必须保留**：现有 `redactTokenInText()` 已在 `launcher.ts:215` 用于 stdout，
  但 **stderr 路径（`launcher.ts:237`）未脱敏**。dsh ≥0.1.2-alpha.1 的 token 是 per-process
  即时凭证（`randomBytes(32)`），一律不得落盘或推给面板。
  → **实现时把 `redactTokenInText` 下沉到 `appendChildOutput` 内部**，stderr 一并覆盖，
  并在面板渲染前再兜一层。
- ring 只是**新面板打开时的历史回填**；实时行走订阅回调，不轮询文件。
- 面板关闭时**必须退订**，否则闭包泄漏（每个 chunk 都遍历死回调）。

---

## 4. 健康状态机（`src/health-monitor.ts`）

用户核心诉求：**"要不不知道 agent 是否健康"**。所以这是本次的价值中心，不是装饰。

### 状态定义

| 状态 | 判定 | 状态栏 | 建议动作 |
|---|---|---|---|
| `starting` | spawn 后未就绪 | 蓝 ● 启动中 | — |
| `ready` | 就绪且近期有输出 | 绿 ● 正常 | — |
| `idle` | ready 但 >120s 无输出 | 灰 ● 空闲 | 提示（非错误，agent 可能真在思考） |
| `degraded` | 60s 内 ERR 行 ≥ 5 | 黄 ● 异常 | 「查看日志」折叠展开 |
| `exited` | `proc.on('exit')` 且非主动退出 | 红 ● 已停止 | **「重启服务」按钮** |
| `error` | `proc.on('error')` | 红 ● 错误 | 「重启服务」+「打开日志」 |

### 判定时序要点

- **静默 ≠ 故障**：agent 正常思考时可能长时间无输出。故 `idle` 用 120s 且**只灰不红**，
  绝不自动重启 —— 误报重启比不报更糟（会丢掉正在进行的会话）。
- **`exited` 是唯一强信号**：`launcher.ts:238` 已有 exit 钩子，直接接入。
- `degraded` 用**滑动窗口**（60s 内 ERR 计数），不用累计值，否则跑一晚上必然全黄。
- 重启动作**只由用户点击触发**，不做自动重启（除用户在设置里显式开启）。

---

## 5. 「重启服务」：一个必须注意的坑

现有只有 `relaunchApp()`（重启整个 App）。新增 `Launcher.restartBackend()`：

```
killPort(当前端口) / killProcessTree(backendProcess)
   ↓
spawnDshWeb(port)  ← 复用 launcher.ts:189
   ↓
waitForServer() 拿新 URL
   ↓
主窗口 win.loadURL(新 URL)
```

> ⚠️ **token 会变**：dsh 每次启动生成新的 per-process token（`randomBytes(32)`，
> 见可行性分析 §acp/鉴权）。新进程意味着**新 token**，
> 老 cookie 失效 → **必须让主窗口重新 `loadURL`**，否则页面 401。
> 这一步是整个重启功能最容易漏、也最容易表现为「重启后面板白屏」的地方。

---

## 6. 状态栏（`assets/statusbar.html`）

固定 24px，横跨全宽。内容（左→右）：

`● 健康状态` · `dsh 版本` · `端口` · `更新通道` · `会话/错误计数` · `[查看日志] [重启服务]`

- 数据由 `health-monitor` 经 IPC 推送（增量更新，不做定时轮询）。
- 「查看日志」= `shell.openPath(getLogDir())`。
- 通道显示复用 `CHANNELS`（`src/channels.ts:60`），risky 通道（alpha/canary）用警示色。

---

## 7. 外部编辑器（`src/external-editor.ts`）

### 偏好结构（`preferences.ts` 扩展）

```ts
externalEditor?: {
  /** 可执行文件路径或 PATH 中的命令名 */
  command: string
  /** 参数模板，支持 {file} {line} {col} 占位符 */
  args?: string
}
```

### 拉起方式

```ts
spawn(command, [...tplArgs, filePath], { detached: true, stdio: 'ignore' }).unref()
```

- **禁用 `shell: true`** —— 路径含空格/中文是常态，且避免命令注入。
- 未配置时的探测顺序：VS Code(`code`) → Notepad++ → 回退 `shell.openPath()`（系统关联）。
- 菜单项「设置 → 外部编辑器…」用 `dialog.showOpenDialog` 选 exe 并写入 prefs。
- 预设常见项（VS Code / Cursor / Notepad++ / 系统默认）供一键选择，也允许自定义。

---

## 8. 文件路径识别与查看（`src/path-links.ts`）

用户诉求：**"dsh 输出文件路径时候打开查看文件"**。

### 识别

在监控面板渲染时，对每一行做（仅对**展示文本**匹配，不改原始日志）：

- Windows：`/[A-Za-z]:[\\/][^\s:*?"<>|]+/g`
- POSIX：`/(?:^|[\s'"(])(?:\/[^\s:'"*?<>|]+)/g`
- 过滤噪声：长度 > 3、含扩展名或路径分隔符、排除纯数字段与 URL。

### 交互

点击路径 → 面板下方小菜单：

| 动作 | 实现 |
|---|---|
| 在外部编辑器打开 | `external-editor.ts`（§7） |
| 在文件管理器中显示 | `shell.showItemInFolder(path)` |
| 在面板内查看 | 主进程读文件（见下） |

### 面板内查看器的硬限制（避免做成半个 IDE）

- 仅**只读**；大小上限 2 MB，超出提示用外部编辑器打开。
- 二进制检测（空字节 / 非 UTF-8）→ 拒绝预览，只给「外部打开」。
- 语法高亮：**不引入新依赖**。阶段一用等宽 `<pre>` + 按扩展名映射 `language-*` class
  （dsh 前端已有 shiki，但那是它的资产，我们跨视图拿不到）。
  真要彩色高亮放阶段三再评估。

---

## 9. 菜单（`src/menu.ts` 扩展）

### 视图菜单（追加）

| 菜单项 | 快捷键 | 说明 |
|---|---|---|
| 显示/隐藏 侧边面板 | `Ctrl+Alt+B` | 整个右栏 |
| 显示/隐藏 监控面板 | `Ctrl+Alt+M` | 仅下半区 |
| 显示/隐藏 状态栏 | `Ctrl+Alt+S` | 底部 |

### 设置菜单（新增）

- 外部编辑器…（§7）
- 打开日志文件夹

> 面板几何（右栏宽度、监控区高度、各面板可见性）持久化到 `~/.dsh/studio-prefs.json`
> （`preferences.ts:47-48`），与现有 `windowBounds` 同级。

---

## 10. 阶段划分与落地顺序

| 阶段 | 内容 | 依赖 | 备注 |
|---|---|---|---|
| **P0 架构铺路** | `window-manager.ts`、IPC 注册表、`panel-preload.ts`、`main.ts` 收敛 | — | 半天；main.ts 已 705 行，建议做 |
| **P1 本次核心** | 监控面板 + 状态栏 + 健康状态机 + 菜单 + 外部编辑器 + 路径识别 | P0 | 用户本次明确要的部分 |
| **P2 变更审阅** | 接 SSE 的 `DiffCallView` + `approval/requested` + `POST /api/respond` | P1 | Codex 式体验的关键，数据在 dsh 已就绪 |
| **P3 增强** | 文件树、语法高亮、变更批量操作 | P2 | 按需，不追求 |

**P1 内部顺序**（保证每步可验证）：
1. `logging.ts` backend ring + 订阅（含 stderr 脱敏补齐）
2. `health-monitor.ts` 状态机 + 单测（纯逻辑，可脱离 Electron 测）
3. 面板 HTML 渲染历史行 + 实时追加（先不做布局美化）
4. `window-manager.ts` 视图叠加与 bounds（先验证 §2 的探针问题）
5. 状态栏 + 菜单
6. 外部编辑器 + 路径识别

---

## 11. 风险与验证清单

| 风险 | 应对 |
|---|---|
| `contentView` 主视图 bounds 不可控 | §2 探针先验证，回退 `BaseWindow` |
| token 泄漏到面板/日志 | 脱敏下沉到 `appendChildOutput`，stderr 一并覆盖；面板渲染前再兜一层 |
| 误报健康告警 | `idle` 只灰不红；`degraded` 用滑动窗口；**绝不自动重启** |
| 重启后白屏 | 见 §5，必须重新 `loadURL` 拿新 cookie |
| 订阅回调泄漏 | 面板关闭时退订；`WebContentsView` 销毁时清理 |
| 大输出刷屏卡 UI | 面板侧节流（如 100ms 批量 flush）+ 上限行数（如 2000 行滚动裁剪） |
| dsh 上游更新冲掉壳 | 壳代码全在 `shell/`，与 dsh workspace 物理隔离（§0 硬约束） |
| 面板遮挡主内容 | ~~主内容 view 一并 `setBounds`~~ **此路已证否**：实测 `BrowserWindow` 自身 webContents 不在 `contentView.children`（`children: 0`，`setBounds` 不可用），主内容区**无法缩小**。改用 `insertCSS` 注入 padding 让内容自行避让，并留 `panel.avoidCss` 逃生开关 |

**验收方式**：壳的改动必须在**真实运行**的下验证——启动壳 → 打开面板 → 触发一次
agent 会话 → 观察输出实时追加 → 手动 kill 后端进程 → 确认状态栏转红且「重启服务」可恢复。
仅编译通过不算完成（历史教训：构建必须实测跑通）。

---

## 12. 本次已完成事项

- ✅ **UU 冲突已解决**：运行副本 `D:\Program Files\DeepseekHarness\deepseek-harness` 的
  `pnpm-lock.yaml` unmerged 状态已清除（`git reset --mixed HEAD`）。
  采用**不产生本地 commit** 的方案（runtime source 不该有本地提交）；
  工作区文件内容逐字节未变（lock 仍为 rc.2 + `unrun` 的正确产物，hash `565c5cf6`）。
  已确认 `hasLocalCommit()`（`runtime-source.ts:261`）实际只检查 HEAD 是否存在，
  故此处是否 commit 均不影响自动更新行为。
- ⚠️ 遗留提示：该副本当前停在 `b150a551`（0.1.1-rc.2），上游 `origin/master` 已到
  `0a53fb55`（0.1.2-alpha.2），且为**浅克隆（3 行 shallow）、两条历史无共同祖先**。
  一旦触发更新将是跨通道大跨度 reset —— 与「更新通道可配置」议题相关，本次未动。

---

## 13. 实施状态（2026-09-01 第三轮）

### P0 架构铺路 —— 已完成
| 模块 | 说明 |
|---|---|
| `src/window-manager.ts` | 叠加层布局；`layout()` / `refreshAvoidance()` / `setAvoidCss()` / `destroy()` |
| `src/ipc-registry.ts` | 所有 IPC 的唯一注册处；`registerIpc()` 返回 teardown |
| `src/panel-preload.ts` | 面板 + 状态栏专用 preload，频道一律 `panel:*` 前缀 |

`main.ts` 的 `setupIPC()` 已拆除，改调 `registerIpc()`。

### P1 —— 已完成
1. **监控数据源**：`logging.appendChildOutput()` 现在写文件 + 后端 ring(500) + 通知订阅者；
   **脱敏下沉到此处**，stdout / stderr 两路都覆盖（修掉了 stderr 裸奔）。
2. **健康状态机** `src/health-monitor.ts`：纯逻辑、零运行时依赖。
   静默≠故障（`idle` 只灰不红，120s）；`degraded` 用滑动窗口（60s / 5 条 ERR）；
   **绝不自动重启**。
3. **面板 + 状态栏**：`assets/panel.html`（变更区占位 + 监控区，100ms 批量 flush、
   2000 行上限、自动滚动开关、splitter 可调高、左边缘拖拽调宽）与
   `assets/statusbar.html`（健康灯 + 相位 + 详情 + 错误数 + dsh 版本/端口/通道；
   「重启服务」仅在 `exited`/`error` 时出现）。
4. **菜单**：视图 → 监控面板 `Ctrl+Alt+B` / 状态栏 `Ctrl+Alt+S` / 避让开关 / 重启后端 / 日志；
   设置 → 选择外部编辑器。
5. **外部编辑器** `src/external-editor.ts`：`shell:false` + detached + unref；
   预设 VS Code / Cursor / Notepad++ / 系统默认，支持「浏览…」指定不在 PATH 的可执行文件。
6. **路径识别** `src/path-links.ts`：输出里的绝对路径转为可点链接，右键菜单
   → 外部编辑器打开 / 在文件夹中显示 / 复制路径。

### 关键修正（相对本文前面几节）
- **§ 架构决策**：主内容 view 无法缩小（见 §11 风险表已订正行）→ 采用 CSS padding 避让。
- **重启服务**：`launcher.restart()` **不走更新流程**（不联网、不 `git reset --hard`），
  只重启后端；新进程 mint 新 token，因此主窗口**必须重新 `loadURL`**，否则白屏 / 401。
  另加 `restarting` 并发闸门，防止状态栏与菜单各点一次 spawn 出两个后端抢端口。
- **菜单 checkbox 是构建时快照**：Electron 不自动刷新 `checked`，每次 toggle 后
  必须 `setupMenu(buildMenuActions())` 重建，否则快捷键切换后菜单显示旧状态。

### 已加固的静态校验（共 332 条断言，`npm test`）
- `test/panel-api.contract.cjs`：`assets/*.html` 用到的 `api.*` ↔ preload 暴露的方法；
  preload 调的 `panel:*` 频道 ↔ `ipc-registry.ts` 注册（**双向**，反向查死 handler）；
  `PHASE_LABEL` 覆盖全部相位。
  → HTML 不在 TS 程序内，拼错方法名打包后表现为「按钮点了没反应」，无报错无日志。
- `test/modules.smoke.cjs`：桩掉 electron 后真实 require 主入口（`app.whenReady()`
  刻意永不 resolve，只验证模块求值干净），并断言三个纯模块 `require()` 列表为空。

### 未验证 / 遗留
- **GUI 未实跑**：当前沙箱跑不了 Electron 渲染管线（`did-finish-load` 永不触发，
  GPU 三种 flag 组合均 exit=3）。验收必须由用户在本机完成：
  启动壳 → `Ctrl+Alt+B` 开面板 → 跑一次 agent 会话确认输出实时追加 →
  手动 kill 后端 → 状态栏转红且出现「重启服务」→ 点击后恢复且页面**不白屏** →
  右键输出里的路径能跳外部编辑器。
- **P2 未做**：变更审阅（接 SSE `DiffCallView` + `approval/requested`）、文件树、git 面板。

---

## 14. P2 变更审阅（2026-09-01 第四轮，已完成）

### 新增模块
| 文件 | 职责 |
|---|---|
| `src/event-store.ts` | **纯逻辑**：SSE 重组、帧归约、call↔approval 关联、变更状态机 |
| `src/dsh-stream.ts` | **唯一 I/O 层**：SSE 连接、退避重连、`session.list` 轮询、`respond()` |

两者严格分离 —— 线路规则（最容易在上游升级时坏、且毫无编译期保护的部分）
全部落在可单测的纯逻辑里；I/O 层薄到只剩 fetch 与定时器。
`dsh-stream.ts` 只依赖 `node:crypto`，**不 import electron**，因此可以在纯 node 下
给 `globalThis.fetch` 打桩驱动真实类。

### 线路契约（rc.2 实测）
- `GET /api/events.mux` → `data: <ServerRequest>\n\n`；**payload 才是帧本体**，
  `rpcId` 在信封层。开流首行是 `: connected\n\n` 注释，不是帧。
- 一帧的 JSON 常被 TCP 切开 → **只能按 `\n\n` 切**。
- `POST /api/respond` 是 **client-response**，必须 echo 信封的 `rpcId`，
  `outcome` 只允许 `allowed-once` / `rejected`。
- 鉴权：rc.2 **完全无 token**；新版追加 `/?token=`。两种都兼容。

### 三条关联规则（漏掉功能就废，且完全无报错）
1. `approval/requested` **不带 diff**，只有可选 `callId` —— 那是回到携带
   `DiffCallView` 的 `tool/call` 的唯一线索。不 join 就只能说「write 请求授权」，
   说不出要写什么。
2. `tool/result` 才证明变更落盘（`tool/call` 只是意图，可能被拒）。
3. 信封 `rpcId` 必须带到 UI —— 丢了就渲染出一个永远答不了的审批卡片，
   host 只回 `{accepted:false,reason:'not-pending'}`。

### 修掉的两个真 bug（都是测试逼出来的，并反向验证过「改回旧代码测试确实会红」）
1. **淘汰时钟误用事件时间戳** → 回放或时钟偏移会让变更一进来就被判为过期。
   改为 `seenAt`（本进程观察到的时刻），且重复投递不续期。
2. **`teardown()` 没清 `running`** → 后端重启换 URL 后 `start()` 走提前 return，
   **永不重连**。这是重启路径的必踩点（新 token = 新 URL）。

### 顺带修掉的 P1 遗留：CSP 静默杀死叠加层
`panel.html` / `statusbar.html` 是内联脚本页却配 `script-src 'self'`，
Chromium 会**静默丢弃**内联脚本 → 页面渲染正常、按钮全死、无任何可见报错。
已改为放行 `'unsafe-inline'`（`default-src 'none'` 仍拦一切远端加载），
并在 `test/panel-api.contract.cjs` 加了静态校验防复发。

### 性能取舍
diff 携带整个文件内容，逐帧广播 IPC 会每秒传几 MB → 主进程只推 **revision 数字**，
面板自己按 120ms 节流拉 `getChanges()`，节流点只有一处。

### 测试（354 条断言全绿）
- `test/event-store.unit.cjs`（37）：跨 chunk 重组（含 7 字节切片喂完整报文）、
  注释行、多帧聚合、坏帧不杀流、审批生命周期、容量上限、TTL。
- `test/dsh-stream.unit.cjs`（28）：假 fetch 驱动真实类 —— URL/token 两种形态、
  respond 回显 rpcId、被拒回执透出 host reason、退避重连、换 URL 重连、
  token 不进日志。
- `test/panel-api.contract.cjs`（58 → 72）：新增 CSP ↔ 内联脚本一致性校验。

### 仍未做
- **GUI 未实跑**（沙箱跑不了 Electron 渲染管线）。
- P2 剩余：文件树、git 面板（dsh 侧零 git 集成、零文件树，需自建：主进程
  `fs` + `spawn git` 即可，不必求 dsh 开接口）。
