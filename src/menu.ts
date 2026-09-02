/**
 * menu.ts — Custom application menu (Chinese).
 * Only includes functional items; removes default Electron items that don't apply.
 */
import { app, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { relaunchApp } from './relaunch.js'
import { CHANNELS, normalizeChannel, type ChannelId } from './channels.js'
import { loadPreferences } from './preferences.js'

/**
 * Everything the menu can do.
 *
 * A single object instead of a positional parameter list: the menu has grown
 * panel and editor entries, and ten positional callbacks is a transposition
 * bug waiting to happen.
 */
export interface MenuActions {
  // ── pre-existing ──
  onCheckUpdate: () => void
  onInstallPluginMarket: () => void
  onShowAbout: () => void
  onSelectChannel: (id: ChannelId) => void
  onShowRecovery: () => void

  // ── overlay panel / status bar ──
  /** Current visibility flags, read when the menu is built. */
  getPanelState: () => {
    panel: boolean
    statusBar: boolean
    sidebar: boolean
  }
  togglePanel: () => void
  toggleStatusBar: () => void
  toggleSidebar: () => void

  // ── backend ──
  restartBackend: () => void
  openLogs: () => void

  // ── diagnostics ──
  /**
   * Open the standalone self-check window.
   *
   * It is deliberately reachable from the menu and a shortcut rather than only
   * from inside the panel: the two failures it was built for (a dead panel
   * preload, an invisible window) are exactly the states in which the panel
   * cannot offer a button.
   */
  openDiagnostics: () => void

  // ── external editor ──
  /** Human-readable description of the current editor. */
  describeEditor: () => string
  chooseEditor: () => void
}

/**
 * Build and set the application menu.
 * Menu structure is rebuilt from scratch on every call, so checkbox/radio
 * marks always reflect the state read at build time.
 */
export function setupMenu(actions: MenuActions): void {
  // Read at build time; switching a channel relaunches the app, which rebuilds
  // the menu, so the radio mark stays in sync.
  const currentChannel = normalizeChannel(loadPreferences().channel)
  const panel = actions.getPanelState()

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: '关于 DeepSeek Studio', click: () => actions.onShowAbout() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { type: 'separator' },
        // ── Overlay panel / sidebar ──
        {
          label: '文件侧栏',
          accelerator: 'Ctrl+Alt+F',
          type: 'checkbox',
          checked: panel.sidebar,
          click: () => actions.toggleSidebar(),
        },
        {
          label: '监控面板',
          accelerator: 'Ctrl+Alt+B',
          type: 'checkbox',
          checked: panel.panel,
          click: () => actions.togglePanel(),
        },
        {
          label: '状态栏',
          accelerator: 'Ctrl+Alt+S',
          type: 'checkbox',
          checked: panel.statusBar,
          click: () => actions.toggleStatusBar(),
        },
        { type: 'separator' },
        {
          label: '重启后端服务',
          click: () => actions.restartBackend(),
        },
        {
          label: '打开日志文件夹',
          click: () => actions.openLogs(),
        },
        {
          label: '诊断自检…',
          accelerator: 'Ctrl+Alt+D',
          click: () => actions.openDiagnostics(),
        },
      ],
    },
    {
      label: '插件市场',
      submenu: [
        {
          label: '安装 dshmarket 插件市场',
          click: () => actions.onInstallPluginMarket(),
        },
      ],
    },
    {
      label: '设置',
      submenu: [
        { label: `外部编辑器：${actions.describeEditor()}`, enabled: false },
        {
          label: '选择外部编辑器…',
          click: () => actions.chooseEditor(),
        },
        {
          label: '外部编辑器说明',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '外部编辑器',
              message: '点击输出里的文件路径时，用哪个编辑器打开？',
              detail:
                `当前：${actions.describeEditor()}\n\n` +
                `· 预设（VS Code / Cursor / Notepad++）按 PATH 查找命令，\n` +
                `  命令不在 PATH 里时请选择「浏览…」直接指定可执行文件。\n` +
                `· 参数模板支持 {file} {line} {col} 占位符，留空等价于 {file}。\n` +
                `· 未配置时使用系统默认程序打开文件。\n` +
                `· 本程序不内置编辑器：编辑始终在你自己的编辑器里进行，\n` +
                `  这样它只是一个「壳」，而不是一个半成品 IDE。`,
              buttons: ['确定'],
            })
          },
        },
      ],
    },
    {
      label: '更新',
      submenu: [
        {
          label: '检查更新',
          click: () => actions.onCheckUpdate(),
        },
        { type: 'separator' },
        {
          label: '更新通道',
          submenu: [
            { label: '决定跟随上游哪个发布通道（默认 next）', enabled: false },
            { type: 'separator' },
            ...CHANNELS.map<MenuItemConstructorOptions>((c) => ({
              label: c.label,
              type: 'radio',
              checked: currentChannel === c.id,
              click: () => actions.onSelectChannel(c.id),
            })),
          ],
        },
        {
          label: '打开恢复指引',
          click: () => actions.onShowRecovery(),
        },
        { type: 'separator' },
        {
          label: '重启应用',
          click: () => relaunchApp(),
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'DeepSeek Harness 文档',
          click: () => {
            shell.openExternal('https://github.com/deepseek-ai/deepseek-harness')
          },
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
