# Augment Monitor

一个用于监控 Augment 使用量和订阅状态的 VS Code 扩展。

## 功能

- 在状态栏实时显示 Augment 使用量
- 自动后台刷新，无需手动点击
- Credits 余额不足时自动告警（状态栏变黄色）
- 查看详细的账号信息和使用量统计
- 支持通过 token 或 portal URL 链接查看使用量
- 显示每日使用量图表
- 支持 Credits 和 User Messages 两种计费模式

## 使用方法

1. 安装扩展后，点击状态栏上的 "Augment" 图标
2. 首次使用时，需要设置 Augment Token
3. 可以输入完整的 portal URL（如 `https://portal.withorb.com/view?token=YOUR_TOKEN`）或直接输入 token 值
4. 设置完成后，点击状态栏图标即可查看详细使用量信息

## 获取 Portal URL

### 方法 1：通过开发者工具获取（推荐）

1. 打开 Augment 订阅页面：https://app.augmentcode.com/account/subscription
2. 按 `F12` 打开浏览器开发者工具
3. 切换到 **Network**（网络）标签
4. 在 **Filter**（过滤器）中输入：`subscription`
5. 点击 **More filters**（更多过滤条件），勾选 `Fetch/XHR`
6. 刷新页面（`F5` 或 `Ctrl+R`）
7. 在请求列表中点击 `subscription` 请求
8. 切换到 **Response**（响应）标签
9. **第一行就是 `portalUrl`**，复制完整的 URL

响应示例：
```json
{
  "portalUrl": "https://portal.withorb.com/view?token=IkhuenhBa2RQWnd1UlBCcUQi.CFl5LP8WAJ9G7hkqxWVKA-ltr-s",
  ...
}
```

### 方法 2：使用 ATM 面板获取

使用 [Augment Token Manager (ATM)](https://github.com/zhaochengcube/augment-token-mng) 扩展，可以更方便地管理和获取 Portal URL。

## 设置 Token

有三种方式可以设置 Token：

1. **命令面板快速设置**：通过命令面板（Ctrl+Shift+P 或 Cmd+Shift+P）执行 "Set Augment Token" 命令
2. **设置面板手动输入**：通过命令面板执行 "Augment Monitor Settings" 打开设置页面，在 `Augment-monitor: Token` 输入框中输入 token
3. **状态栏提示设置**：点击状态栏上的 "Augment" 图标，如果未设置 token，会提示设置

支持两种输入格式：
- 完整 URL：`https://portal.withorb.com/view?token=YOUR_TOKEN`
- 仅 Token：`YOUR_TOKEN`

## 查看使用量

设置 Token 后，点击状态栏上的 "Augment" 图标即可查看详细的使用量信息，包括：

- 账号邮箱
- 注册日期和到期日期
- 总额度、已用额度和剩余额度
- 使用进度条
- 每日使用量图表

## 配置选项

通过命令面板（Ctrl+Shift+P 或 Cmd+Shift+P）执行 "Set Augment Token" 命令，或在 VS Code 设置中搜索 "Augment Monitor"  可以配置以下选项：

- **启用自动刷新** (`augment-monitor.enableAutoRefresh`)
  - 默认：启用
  - 说明：是否在后台自动刷新使用量数据

- **刷新间隔** (`augment-monitor.refreshInterval`)
  - 默认：300 秒（5 分钟）
  - 最小值：5 秒
  - 说明：自动刷新的时间间隔

- **告警阈值** (`augment-monitor.alertThreshold`)
  - 默认：4000 Credits
  - 说明：当 Credits 剩余低于此值时，状态栏会显示黄色告警

## 告警功能

当您的 Credits 余额低于设定的阈值时：
- 状态栏背景会变为黄色
- 图标会从 `$(pulse)` 变为 `$(alert)`
- 显示 ⚠️ 警告符号
- 鼠标悬停会提示"Credits 余额不足"

## 开发

### 构建

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 打包
npm run package
```
