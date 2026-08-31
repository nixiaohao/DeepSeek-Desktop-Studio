/**
 * menu.ts — Custom application menu (Chinese).
 * Only includes functional items; removes default Electron items that don't apply.
 */
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { relaunchApp } from './relaunch.js'
import { CHANNELS, normalizeChannel, type ChannelId } from './channels.js'
import { loadPreferences } from './preferences.js'

/**
 * Build and set the application menu.
 * @param onCheckUpdate called when the user clicks "Check for updates"
 * @param onInstallPluginMarket called when the user clicks "Install plugin market"
 * @param onShowAbout called when the user clicks "About" (custom dialog)
 * @param onSelectChannel called with the chosen channel id from 更新通道
 * @param onShowRecovery called when the user clicks 打开恢复指引
 */
export function setupMenu(
  onCheckUpdate: () => void,
  onInstallPluginMarket: () => void,
  onShowAbout: () => void,
  onSelectChannel: (id: ChannelId) => void,
  onShowRecovery: () => void
): void {
  // Read at build time; switching a channel relaunches the app, which rebuilds
  // the menu, so the radio mark stays in sync.
  const currentChannel = normalizeChannel(loadPreferences().channel)

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: '关于 DeepSeek Studio', click: () => onShowAbout() },
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
      ],
    },
    {
      label: '插件市场',
      submenu: [
        {
          label: '安装 dshmarket 插件市场',
          click: () => onInstallPluginMarket(),
        },
      ],
    },
    {
      label: '更新',
      submenu: [
        {
          label: '检查更新',
          click: () => onCheckUpdate(),
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
              click: () => onSelectChannel(c.id),
            })),
          ],
        },
        {
          label: '打开恢复指引',
          click: () => onShowRecovery(),
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
