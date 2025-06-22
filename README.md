# Augment Monitor

一个用于监控 Augment 使用量和订阅状态的 VS Code 扩展。

## 功能

- 在状态栏显示 Augment 使用量
- 查看详细的账号信息和使用量统计
- 支持通过 token 或 portal URL 链接查看使用量
- 显示每日使用量图表

## 使用方法

1. 安装扩展后，点击状态栏上的 "Augment" 图标
2. 首次使用时，需要设置 Augment Token
3. 可以输入完整的 portal URL（如 `https://portal.withorb.com/view?token=YOUR_TOKEN`）或直接输入 token 值
4. 设置完成后，点击状态栏图标即可查看详细使用量信息

## 设置 Token

有两种方式可以设置 Token：

1. 点击状态栏上的 "Augment" 图标，如果未设置 token，会提示设置
2. 通过命令面板（Ctrl+Shift+P 或 Cmd+Shift+P）执行 "Set Augment Token" 命令

## 查看使用量

设置 Token 后，点击状态栏上的 "Augment" 图标即可查看详细的使用量信息，包括：

- 账号邮箱
- 注册日期和到期日期
- 总额度、已用额度和剩余额度
- 使用进度条
- 每日使用量图表

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
