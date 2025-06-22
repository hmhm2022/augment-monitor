import * as vscode from 'vscode';
import axios from 'axios';

// 定义 Augment 使用量信息接口
interface AugmentUsageInfo {
  email: string;
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  registrationDate: string;
  expirationDate: string;
  dailyUsage?: { date: string, usage: number }[];
  subscriptionInfo?: {
    id: string;
    name: string;
    status: string;
    currency: string;
    billingMode: string;
    currentBillingPeriod?: {
      start: string;
      end: string;
    };
    priceIntervals?: PriceInterval[];
  };
}

// 定义价格区间接口
interface PriceInterval {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  billingCycleDay: number;
  allocation?: {
    amount: string;
    cadence: string;
    pricingUnit: string;
  };
  price: {
    name: string;
    unitAmount: string;
    currency: string;
    modelType: string;
  };
}

// 状态栏项
let statusBarItem: vscode.StatusBarItem;

// 激活扩展
export function activate(context: vscode.ExtensionContext) {
  console.log('Augment Monitor 扩展已激活');

  // 创建状态栏项
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(pulse) Augment";
  statusBarItem.tooltip = "查看 Augment 使用量";
  statusBarItem.command = 'augment-monitor.showUsage';
  statusBarItem.show();

  // 注册命令
  let showUsageCommand = vscode.commands.registerCommand('augment-monitor.showUsage', async () => {
    await showAugmentUsage(context);
  });

  let setTokenCommand = vscode.commands.registerCommand('augment-monitor.setToken', async () => {
    await setAugmentToken(context);
  });

  // 添加到订阅
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(showUsageCommand);
  context.subscriptions.push(setTokenCommand);

  // 检查是否已设置 token
  const token = context.globalState.get<string>('augmentToken');
  if (!token) {
    vscode.window.showInformationMessage('请设置 Augment Token 以查看使用量', '设置 Token').then(selection => {
      if (selection === '设置 Token') {
        vscode.commands.executeCommand('augment-monitor.setToken');
      }
    });
  }
}

// 设置 Augment Token
async function setAugmentToken(context: vscode.ExtensionContext) {
  const tokenInput = await vscode.window.showInputBox({
    placeHolder: '请输入 Augment Token 或完整的 portal URL',
    prompt: '例如: IkhuenhBa2RQWnd1UlBCcUQi.CFl5LP8WAJ9G7hkqxWVKA-ltr-s 或 https://portal.withorb.com/view?token=IkhuenhBa2RQWnd1UlBCcUQi.CFl5LP8WAJ9G7hkqxWVKA-ltr-s',
    ignoreFocusOut: true
  });

  if (!tokenInput) {
    return;
  }

  // 从输入中提取 token
  let token = tokenInput;
  if (tokenInput.includes('token=')) {
    const match = tokenInput.match(/token=([^&]+)/);
    if (match && match[1]) {
      token = match[1];
    }
  }

  // 保存 token
  await context.globalState.update('augmentToken', token);
  vscode.window.showInformationMessage('Augment Token 已保存');

  // 立即显示使用量
  await showAugmentUsage(context);
}

// 显示 Augment 使用量
async function showAugmentUsage(context: vscode.ExtensionContext) {
  const token = context.globalState.get<string>('augmentToken');

  if (!token) {
    vscode.window.showWarningMessage('请先设置 Augment Token', '设置 Token').then(selection => {
      if (selection === '设置 Token') {
        vscode.commands.executeCommand('augment-monitor.setToken');
      }
    });
    return;
  }

  try {
    // 显示加载状态
    statusBarItem.text = "$(sync~spin) 加载中...";

    // 获取 Augment 使用量信息
    const usageInfo = await fetchAugmentUsage(token);

    // 更新状态栏
    statusBarItem.text = `$(pulse) Augment: ${usageInfo.remainingTokens}/${usageInfo.totalTokens}`;

    // 创建 WebView 面板显示详细信息
    const panel = vscode.window.createWebviewPanel(
      'augmentUsage',
      'Augment 使用量',
      vscode.ViewColumn.One,
      {
        enableScripts: true
      }
    );

    // 设置 WebView 内容
    panel.webview.html = getWebviewContent(usageInfo);
  } catch (error) {
    console.error('获取 Augment 使用量失败:', error);
    statusBarItem.text = "$(pulse) Augment";

    if (axios.isAxiosError(error) && error.response) {
      vscode.window.showErrorMessage(`获取 Augment 使用量失败: ${error.response.status} ${error.response.statusText}`);
    } else {
      vscode.window.showErrorMessage(`获取 Augment 使用量失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// 将 view URL 转换为 API URL
function viewUrlToApiUrl(token: string): string {
  // 如果 token 是完整的 URL，从中提取 token
  if (token.includes('token=')) {
    const match = token.match(/token=([^&]+)/);
    if (match && match[1]) {
      token = match[1];
    }
  }
  return `https://portal.withorb.com/api/v1/subscriptions_from_link?token=${token}`;
}

// UTC转北京时间
function utcToBeijing(utc: string): string {
  if (!utc) return "";
  const date = new Date(utc);
  date.setHours(date.getHours() + 8);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// 获取 Augment 使用量信息
async function fetchAugmentUsage(token: string): Promise<AugmentUsageInfo> {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    };

    // 1. 获取订阅信息
    const subscriptionUrl = viewUrlToApiUrl(token);
    const subscriptionResponse = await axios.get(subscriptionUrl, { headers });

    if (!subscriptionResponse.data || !subscriptionResponse.data.data || !subscriptionResponse.data.data[0]) {
      throw new Error('未获取到订阅信息');
    }

    const info = subscriptionResponse.data.data[0];
    const email = info.customer?.name || '';
    const regDate = utcToBeijing(info.start_date);
    const expDate = utcToBeijing(info.end_date);
    const subscription_id = info.id;

    // 解析价格区间信息
    const priceIntervals: PriceInterval[] = [];
    let currentUserMessagePriceId = '';
    let currentAllocation = 0;

    // 找到当前活跃的计费周期
    const now = new Date();
    const activePriceIntervals = info.price_intervals?.filter((p: any) => {
      const startDate = new Date(p.start_date);
      const endDate = new Date(p.end_date);
      return p.current_billing_period_start_date && p.current_billing_period_end_date;
    }) || [];

    // 处理所有价格区间
    for (const priceInterval of info.price_intervals || []) {
      const intervalInfo: PriceInterval = {
        id: priceInterval.id,
        name: priceInterval.price?.price?.name || '',
        startDate: utcToBeijing(priceInterval.start_date),
        endDate: utcToBeijing(priceInterval.end_date),
        billingCycleDay: priceInterval.billing_cycle_day || 0,
        price: {
          name: priceInterval.price?.price?.name || '',
          unitAmount: priceInterval.price?.price?.unit_config?.unit_amount || '0.00',
          currency: priceInterval.price?.price?.currency || '',
          modelType: priceInterval.price?.price?.model_type || ''
        }
      };

      // 处理分配信息
      if (priceInterval.allocation) {
        intervalInfo.allocation = {
          amount: priceInterval.allocation.amount,
          cadence: priceInterval.allocation.cadence,
          pricingUnit: priceInterval.allocation.pricing_unit?.display_name || ''
        };

        // 如果是当前活跃的分配，记录总额度
        if (priceInterval.current_billing_period_start_date &&
            intervalInfo.allocation.pricingUnit.includes('User Messages')) {
          currentAllocation = parseInt(priceInterval.allocation.amount.split('.')[0]);
        }
      }

      // 找到当前活跃的 User Message 价格ID
      if (priceInterval.current_billing_period_start_date &&
          intervalInfo.name === 'User Message') {
        currentUserMessagePriceId = priceInterval.price?.id || '';
      }

      priceIntervals.push(intervalInfo);
    }

    // 如果没有找到当前活跃的分配，使用最新的分配
    if (currentAllocation === 0) {
      const latestAllocation = info.price_intervals
        ?.filter((p: any) => p.allocation && p.price?.price?.name === "Included Allocation (User Messages)")
        ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

      if (latestAllocation?.allocation?.amount) {
        currentAllocation = parseInt(latestAllocation.allocation.amount.split('.')[0]);
      }
    }

    // 如果没有找到当前活跃的价格ID，使用最新的
    if (!currentUserMessagePriceId) {
      const latestUserMessage = info.price_intervals
        ?.filter((p: any) => p.price?.price?.name === "User Message")
        ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

      currentUserMessagePriceId = latestUserMessage?.price?.id || '';
    }

    const total = currentAllocation || 600; // 默认600

    // 2. 获取用量信息
    if (!subscription_id || !currentUserMessagePriceId) {
      throw new Error('未获取到订阅ID或价格ID');
    }

    // 确保 token 不包含 URL 部分
    let cleanToken = token;
    if (cleanToken.includes('token=')) {
      const match = cleanToken.match(/token=([^&]+)/);
      if (match && match[1]) {
        cleanToken = match[1];
      }
    }

    const usageUrl = `https://portal.withorb.com/api/v1/subscriptions/${subscription_id}/usage?price_id=${currentUserMessagePriceId}&token=${cleanToken}`;
    const usageResponse = await axios.get(usageUrl, { headers });

    if (!usageResponse.data || !usageResponse.data.data_series) {
      throw new Error('未获取到用量信息');
    }

    // 处理用量数据
    let used = 0;
    const dailyUsage: { date: string, usage: number }[] = [];

    for (const entry of usageResponse.data.data_series) {
      const date = entry.date.slice(5, 10); // MM-DD
      const values = entry.values;
      let usage = 0;

      if (values) {
        usage = Object.values(values)[0] as number;
        used += usage;
      }

      dailyUsage.push({ date, usage });
    }

    const remain = total - used;

    // 获取当前计费周期信息
    const currentBillingPeriod = activePriceIntervals.length > 0 ? {
      start: utcToBeijing(activePriceIntervals[0].current_billing_period_start_date),
      end: utcToBeijing(activePriceIntervals[0].current_billing_period_end_date)
    } : undefined;

    // 返回格式化的使用量信息
    return {
      email,
      totalTokens: total,
      usedTokens: used,
      remainingTokens: remain,
      registrationDate: regDate,
      expirationDate: expDate,
      dailyUsage,
      subscriptionInfo: {
        id: subscription_id,
        name: info.name || '',
        status: info.status || '',
        currency: info.currency || '',
        billingMode: info.billing_mode || '',
        currentBillingPeriod,
        priceIntervals
      }
    };
  } catch (error) {
    console.error('API 请求失败:', error);
    throw error;
  }
}

// 格式化日期
function formatDate(dateString: string): string {
  if (!dateString) return 'N/A';

  try {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch (e) {
    return dateString;
  }
}

// 生成 WebView 内容
function getWebviewContent(usageInfo: AugmentUsageInfo): string {
  // 准备图表数据
  const labels = usageInfo.dailyUsage?.map(item => item.date) || [];
  const usages = usageInfo.dailyUsage?.map(item => item.usage) || [];
  const maxUsage = Math.max(...usages, 0);
  const yMax = Math.max(8, maxUsage + 1);

  // 动态选择最接近官网风格的刻度间隔
  let stepSize = 8; // 默认与官网一致
  if (maxUsage <= 10) {
    stepSize = 2;
  } else if (maxUsage <= 20) {
    stepSize = 4;
  } else if (maxUsage <= 40) {
    stepSize = 8;
  } else {
    stepSize = 16;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Augment 使用量</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      color: var(--vscode-editor-foreground);
    }
    .info-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    .info-table td {
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
    }
    .info-table tr td:first-child {
      width: 40%;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: bold;
    }
    .progress-container {
      width: 100%;
      height: 20px;
      background-color: var(--vscode-progressBar-background);
      border-radius: 10px;
      margin: 20px 0;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      background-color: var(--vscode-progressBar-foreground);
      border-radius: 10px;
      transition: width 0.3s ease;
    }
    .usage-text {
      text-align: center;
      margin-top: 10px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
    }
    .chart-section {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      padding: 24px 20px 12px 20px;
      height: 250px;
      margin-top: 30px;
    }
    .chart-title {
      font-size: 1.15em;
      color: var(--vscode-editor-foreground);
      margin-bottom: 10px;
    }
    #chart {
      max-width: 100%;
      max-height: 200px;
    }
    .price-intervals-section {
      margin-top: 30px;
    }
    .price-intervals-section h2 {
      font-size: 20px;
      margin-bottom: 15px;
      color: var(--vscode-editor-foreground);
    }
    .price-intervals-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
    }
    .price-interval-card {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      padding: 15px;
      border: 1px solid var(--vscode-panel-border);
    }
    .price-interval-card h3 {
      font-size: 16px;
      margin-bottom: 10px;
      color: var(--vscode-editor-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 5px;
    }
    .interval-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .interval-table td {
      padding: 5px 8px;
      border: 1px solid var(--vscode-panel-border);
    }
    .interval-table tr td:first-child {
      width: 35%;
      background-color: var(--vscode-input-background);
      font-weight: bold;
      font-size: 11px;
    }
    .interval-table tr td:last-child {
      font-family: 'Courier New', monospace;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Augment 使用量信息</h1>

    <table class="info-table">
      <tr>
        <td>邮箱</td>
        <td>${usageInfo.email}</td>
      </tr>
      <tr>
        <td>订阅名称</td>
        <td>${usageInfo.subscriptionInfo?.name || 'N/A'}</td>
      </tr>
      <tr>
        <td>订阅状态</td>
        <td>${usageInfo.subscriptionInfo?.status || 'N/A'}</td>
      </tr>
      <tr>
        <td>计费模式</td>
        <td>${usageInfo.subscriptionInfo?.billingMode || 'N/A'}</td>
      </tr>
      <tr>
        <td>货币</td>
        <td>${usageInfo.subscriptionInfo?.currency || 'N/A'}</td>
      </tr>
      ${usageInfo.subscriptionInfo?.currentBillingPeriod ? `
      <tr>
        <td>当前计费周期</td>
        <td>${usageInfo.subscriptionInfo.currentBillingPeriod.start} 至 ${usageInfo.subscriptionInfo.currentBillingPeriod.end}</td>
      </tr>
      ` : ''}
      <tr>
        <td>注册日期 (北京时间)</td>
        <td>${usageInfo.registrationDate}</td>
      </tr>
      <tr>
        <td>到期日期 (北京时间)</td>
        <td>${usageInfo.expirationDate}</td>
      </tr>
      <tr>
        <td>总额度</td>
        <td>${usageInfo.totalTokens}</td>
      </tr>
      <tr>
        <td>已用</td>
        <td>${usageInfo.usedTokens}</td>
      </tr>
      <tr>
        <td>剩余</td>
        <td>${usageInfo.remainingTokens}</td>
      </tr>
    </table>

    <div class="progress-container">
      <div class="progress-bar" style="width: ${(usageInfo.usedTokens / usageInfo.totalTokens) * 100}%"></div>
    </div>

    <div class="usage-text">
      已使用 ${usageInfo.usedTokens} / ${usageInfo.totalTokens} (${((usageInfo.usedTokens / usageInfo.totalTokens) * 100).toFixed(2)}%)
    </div>

    <div class="chart-section">
      <div class="chart-title">当前账单周期用量（User Message）</div>
      <canvas id="chart"></canvas>
    </div>

    ${usageInfo.subscriptionInfo?.priceIntervals && usageInfo.subscriptionInfo.priceIntervals.length > 0 ? `
    <div class="price-intervals-section">
      <h2>价格区间详情</h2>
      <div class="price-intervals-container">
        ${usageInfo.subscriptionInfo.priceIntervals.map(interval => `
          <div class="price-interval-card">
            <h3>${interval.name || '未命名'}</h3>
            <table class="interval-table">
              <tr>
                <td>ID</td>
                <td>${interval.id}</td>
              </tr>
              <tr>
                <td>开始日期</td>
                <td>${interval.startDate}</td>
              </tr>
              <tr>
                <td>结束日期</td>
                <td>${interval.endDate}</td>
              </tr>
              <tr>
                <td>计费周期日</td>
                <td>${interval.billingCycleDay}</td>
              </tr>
              <tr>
                <td>单价</td>
                <td>${interval.price.unitAmount} ${interval.price.currency}</td>
              </tr>
              <tr>
                <td>模型类型</td>
                <td>${interval.price.modelType}</td>
              </tr>
              ${interval.allocation ? `
              <tr>
                <td>分配额度</td>
                <td>${interval.allocation.amount} ${interval.allocation.pricingUnit} (${interval.allocation.cadence})</td>
              </tr>
              ` : ''}
            </table>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}
  </div>

  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    const usages = ${JSON.stringify(usages)};
    const labels = ${JSON.stringify(labels)};
    const maxUsage = ${maxUsage};
    const yMax = ${yMax};
    const stepSize = ${stepSize};

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '每日用量',
          data: usages,
          backgroundColor: 'rgba(99, 102, 241, 0.25)',
          borderColor: 'rgba(99, 102, 241, 1)',
          borderWidth: 1.5,
          borderRadius: 4,
          maxBarThickness: 32,
          barPercentage: 0.7,
          categoryPercentage: 0.7
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: yMax,
            title: { display: true, text: '用量' },
            grid: { color: 'rgba(200, 200, 200, 0.2)' },
            ticks: {
              stepSize: stepSize,
              font: {
                size: 10
              }
            }
          },
          x: {
            grid: { color: 'rgba(200, 200, 200, 0.1)' },
            ticks: {
              font: {
                size: 10
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

// 停用扩展
export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
