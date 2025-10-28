import * as vscode from 'vscode';
import axios from 'axios';

// 定义 Augment 使用量信息接口
interface AugmentUsageInfo {
  email: string;

  // 新增: 计费模式标识
  billingType: 'credits' | 'user-messages';

  // 新增: 通用字段(兼容新旧)
  totalAmount: number;      // 总额度(credits 或 messages)
  usedAmount: number;       // 已用(credits 或 messages)
  remainingAmount: number;  // 剩余(credits 或 messages)
  unit: string;             // 单位名称 "Credits" 或 "User Messages"

  // 保留旧字段(向下兼容)
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;

  registrationDate: string;
  expirationDate: string;
  dailyUsage?: { date: string, usage: number }[];

  // 新增: 模型使用分布(仅 Credits 模式)
  modelUsage?: {
    sonnet?: number;
    haiku?: number;
    gpt5?: number;
  };

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

// 自动刷新定时器
let refreshTimer: NodeJS.Timeout | undefined;

// 是否正在刷新（防止并发）
let isRefreshing = false;

// 缓存的使用量信息
let cachedUsageInfo: AugmentUsageInfo | null = null;

// 获取 Token（优先从配置读取，其次从 globalState 读取）
function getToken(context: vscode.ExtensionContext): string | undefined {
  // 优先从 workspace configuration 读取
  const config = vscode.workspace.getConfiguration('augment-monitor');
  const configToken = config.get<string>('token');

  if (configToken && configToken.trim()) {
    return configToken.trim();
  }

  // 如果配置中没有，从 globalState 读取（向后兼容）
  return context.globalState.get<string>('augmentToken');
}

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

  let openSettingsCommand = vscode.commands.registerCommand('augment-monitor.openSettings', () => {
    // 打开设置页面并聚焦到 Augment Monitor 扩展的设置
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:augment-code.augment-monitor');
  });

  // 添加到订阅
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(showUsageCommand);
  context.subscriptions.push(setTokenCommand);
  context.subscriptions.push(openSettingsCommand);

  // 检查是否已设置 token
  const token = getToken(context);
  if (!token) {
    vscode.window.showInformationMessage('请设置 Augment Token 以查看使用量', '设置 Token').then(selection => {
      if (selection === '设置 Token') {
        vscode.commands.executeCommand('augment-monitor.setToken');
      }
    });
  } else {
    // 启动时立即获取一次数据
    updateUsageData(context);

    // 启动自动刷新
    startAutoRefresh(context);
  }

  // 监听配置变化
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('augment-monitor.enableAutoRefresh') ||
          e.affectsConfiguration('augment-monitor.refreshInterval')) {
        stopAutoRefresh();
        const token = getToken(context);
        if (token) {
          startAutoRefresh(context);
        }
      }

      // 监听 token 配置变化
      if (e.affectsConfiguration('augment-monitor.token')) {
        const token = getToken(context);
        if (token) {
          // Token 已设置，立即刷新数据
          updateUsageData(context);
          // 重启自动刷新
          stopAutoRefresh();
          startAutoRefresh(context);
        } else {
          // Token 被清空，停止刷新
          stopAutoRefresh();
          statusBarItem.text = "$(pulse) Augment";
          statusBarItem.backgroundColor = undefined;
        }
      }
    })
  );
}

// 启动自动刷新
function startAutoRefresh(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('augment-monitor');
  const enableAutoRefresh = config.get<boolean>('enableAutoRefresh', true);

  if (!enableAutoRefresh) {
    return;
  }

  const refreshInterval = Math.max(config.get<number>('refreshInterval', 300), 5);

  refreshTimer = setInterval(() => {
    updateUsageData(context);
  }, refreshInterval * 1000);
}

// 停止自动刷新
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

// 更新使用量数据（后台静默更新）
async function updateUsageData(context: vscode.ExtensionContext) {
  // 防止并发请求
  if (isRefreshing) {
    return;
  }

  const token = getToken(context);
  if (!token) {
    return;
  }

  isRefreshing = true;
  try {
    const usageInfo = await fetchAugmentUsage(token);
    if (usageInfo) {
      cachedUsageInfo = usageInfo;
      updateStatusBar(usageInfo);
    }
  } catch (error) {
    console.error('后台更新使用量失败:', error);
  } finally {
    isRefreshing = false;
  }
}

// 更新状态栏显示
function updateStatusBar(usageInfo: AugmentUsageInfo) {
  const config = vscode.workspace.getConfiguration('augment-monitor');
  const alertThreshold = config.get<number>('alertThreshold', 4000);

  if (usageInfo.billingType === 'credits') {
    const remaining = usageInfo.remainingAmount;
    const total = usageInfo.totalAmount;

    // 判断是否需要告警
    if (remaining < alertThreshold) {
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.text = `$(alert) Augment: ${remaining.toLocaleString()}/${total.toLocaleString()} Credits ⚠️`;
      statusBarItem.tooltip = `⚠️ Credits 余额不足！剩余 ${remaining.toLocaleString()} Credits`;
    } else {
      statusBarItem.backgroundColor = undefined;
      statusBarItem.text = `$(pulse) Augment: ${remaining.toLocaleString()}/${total.toLocaleString()} Credits`;
      statusBarItem.tooltip = `查看 Augment 使用量\n剩余 ${remaining.toLocaleString()} Credits`;
    }
  } else {
    // User Messages 模式不需要告警
    statusBarItem.backgroundColor = undefined;
    statusBarItem.text = `$(pulse) Augment: ${usageInfo.remainingAmount}/${usageInfo.totalAmount} Messages`;
    statusBarItem.tooltip = `查看 Augment 使用量\n剩余 ${usageInfo.remainingAmount} Messages`;
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

  // 保存 token 到配置（推荐方式）
  const config = vscode.workspace.getConfiguration('augment-monitor');
  await config.update('token', token, vscode.ConfigurationTarget.Global);

  // 同时保存到 globalState（向后兼容）
  await context.globalState.update('augmentToken', token);

  vscode.window.showInformationMessage('Augment Token 已保存');

  // 立即显示使用量
  await showAugmentUsage(context);
}

// 显示 Augment 使用量
async function showAugmentUsage(context: vscode.ExtensionContext) {
  const token = getToken(context);

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

    // 更新状态栏 - 动态显示单位
    const displayText = usageInfo.billingType === 'credits'
      ? `$(pulse) Augment: ${usageInfo.remainingAmount.toLocaleString()}/${usageInfo.totalAmount.toLocaleString()} Credits`
      : `$(pulse) Augment: ${usageInfo.remainingAmount}/${usageInfo.totalAmount} Messages`;
    statusBarItem.text = displayText;

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

  // 解析 UTC 时间
  const date = new Date(utc);

  // 加上 8 小时的毫秒数 (北京时间 = UTC+8)
  const offset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(date.getTime() + offset);

  // 手动格式化为 YYYY-MM-DD HH:mm:ss
  // 使用 getUTC*() 方法获取已经加了 8 小时后的时间
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hour = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minute = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const second = String(beijingTime.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
    const regDate = utcToBeijing(info.creation_time);  // 使用 creation_time 而不是 start_date
    const expDate = utcToBeijing(info.end_date);
    const subscription_id = info.id;

    // 调试日志: 打印所有 price_intervals
    console.log('=== 调试信息: 所有 price_intervals ===');
    console.log('订阅ID:', subscription_id);
    console.log('price_intervals 数量:', info.price_intervals?.length || 0);
    info.price_intervals?.forEach((p: any, index: number) => {
      console.log(`\n--- Price Interval ${index + 1} ---`);
      console.log('ID:', p.id);
      console.log('Price ID:', p.price?.id);
      console.log('Price Name:', p.price?.price?.name);
      console.log('Pricing Unit:', p.allocation?.pricing_unit?.display_name);
      console.log('Allocation Amount:', p.allocation?.amount);
      console.log('Has Current Billing Period:', !!p.current_billing_period_start_date);
      console.log('Start Date:', p.start_date);
      console.log('End Date:', p.end_date);
    });
    console.log('=== 调试信息结束 ===\n');

    // 解析价格区间信息
    const priceIntervals: PriceInterval[] = [];
    let currentPriceId = '';
    let currentAllocation = 0;
    let billingType: 'credits' | 'user-messages' = 'user-messages'; // 默认旧模式
    let unit = 'User Messages';

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

        // 检测计费模式并记录总额度
        if (priceInterval.current_billing_period_start_date) {
          const pricingUnit = intervalInfo.allocation.pricingUnit;

          // 优先检测 Credits 模式
          if (pricingUnit.includes('Credits') || pricingUnit.includes('credits')) {
            billingType = 'credits';
            unit = 'Credits';
            currentAllocation = parseInt(priceInterval.allocation.amount.split('.')[0]);
          }
          // 向下兼容 User Messages 模式
          else if (pricingUnit.includes('User Messages')) {
            billingType = 'user-messages';
            unit = 'User Messages';
            currentAllocation = parseInt(priceInterval.allocation.amount.split('.')[0]);
          }
        }
      }

      // 找到当前活跃的价格ID (Credits 或 User Message)
      if (priceInterval.current_billing_period_start_date) {
        const priceName = intervalInfo.name;
        const priceId = priceInterval.price?.id || '';

        // 优先查找 "Augment Credits" (不是 "Included Allocation")
        if (priceName === 'Augment Credits' && priceId) {
          currentPriceId = priceId;
          billingType = 'credits';
          unit = 'Credits';
          console.log('✓ 找到 Augment Credits 价格ID:', currentPriceId);
        }
        // 向下兼容其他 Credits 相关价格
        else if (!currentPriceId && priceName.includes('Credit') && !priceName.includes('Included Allocation') && priceId) {
          currentPriceId = priceId;
          billingType = 'credits';
          unit = 'Credits';
          console.log('✓ 找到 Credits 价格ID:', currentPriceId);
        }
        // 向下兼容 User Message (包括 "User Message" 和 "Fractional Messages")
        else if ((priceName === 'User Message' || priceName === 'Fractional Messages') && priceId && !currentPriceId) {
          currentPriceId = priceId;
          billingType = 'user-messages';
          unit = 'User Messages';
          console.log('✓ 找到 User Message 价格ID:', currentPriceId, '(', priceName, ')');
        }
      }

      priceIntervals.push(intervalInfo);
    }

    // 如果没有找到当前活跃的分配，使用最新的分配
    if (currentAllocation === 0) {
      // 优先查找 Credits 分配
      let latestAllocation = info.price_intervals
        ?.filter((p: any) => p.allocation && (
          p.price?.price?.name?.includes('Credits') ||
          p.price?.price?.name?.includes('Included Allocation (Credits)')
        ))
        ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

      if (latestAllocation?.allocation?.amount) {
        currentAllocation = parseInt(latestAllocation.allocation.amount.split('.')[0]);
        billingType = 'credits';
        unit = 'Credits';
      } else {
        // 向下兼容: 查找 User Messages 分配
        latestAllocation = info.price_intervals
          ?.filter((p: any) => p.allocation && p.price?.price?.name === "Included Allocation (User Messages)")
          ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

        if (latestAllocation?.allocation?.amount) {
          currentAllocation = parseInt(latestAllocation.allocation.amount.split('.')[0]);
          billingType = 'user-messages';
          unit = 'User Messages';
        }
      }
    }

    // 如果没有找到当前活跃的价格ID，使用最新的
    if (!currentPriceId) {
      // 优先查找 "Augment Credits" 价格
      let latestPrice = info.price_intervals
        ?.filter((p: any) => p.price?.price?.name === "Augment Credits")
        ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

      if (latestPrice?.price?.id) {
        currentPriceId = latestPrice.price.id;
        billingType = 'credits';
        unit = 'Credits';
      } else {
        // 查找其他 Credits 相关价格(排除 Included Allocation)
        latestPrice = info.price_intervals
          ?.filter((p: any) => {
            const name = p.price?.price?.name || '';
            return name.includes('Credit') && !name.includes('Included Allocation');
          })
          ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

        if (latestPrice?.price?.id) {
          currentPriceId = latestPrice.price.id;
          billingType = 'credits';
          unit = 'Credits';
        } else {
          // 向下兼容: 查找 User Message 价格 (包括 "User Message" 和 "Fractional Messages")
          latestPrice = info.price_intervals
            ?.filter((p: any) => {
              const name = p.price?.price?.name || '';
              return name === "User Message" || name === "Fractional Messages";
            })
            ?.sort((a: any, b: any) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())[0];

          if (latestPrice?.price?.id) {
            currentPriceId = latestPrice.price.id;
            billingType = 'user-messages';
            unit = 'User Messages';
          }
        }
      }
    }

    // 确保 token 不包含 URL 部分
    let cleanToken = token;
    if (cleanToken.includes('token=')) {
      const match = cleanToken.match(/token=([^&]+)/);
      if (match && match[1]) {
        cleanToken = match[1];
      }
    }

    // 2. 获取 Customer 信息 (用于获取实际剩余额度)
    // 注意: 只有新的 Credits 模式才有 ledger_pricing_units
    // 老的 User Messages 模式没有此字段,需要使用 Allocation 方式
    let creditsBalance = 0;
    let customerId = '';
    let pricingUnitId = '';

    // 只有 Credits 模式才尝试获取 Ledger Summary
    if (billingType === 'credits') {
      try {
        const customerUrl = `https://portal.withorb.com/api/v1/customer_from_link?token=${cleanToken}`;
        const customerResponse = await axios.get(customerUrl, { headers });

        customerId = customerResponse.data.customer?.id || '';
        pricingUnitId = customerResponse.data.customer?.ledger_pricing_units?.[0]?.id || '';

        console.log('✓ Customer ID:', customerId);
        console.log('✓ Pricing Unit ID:', pricingUnitId);

        // 3. 获取 Ledger Summary (实际剩余额度)
        if (customerId && pricingUnitId) {
          const ledgerUrl = `https://portal.withorb.com/api/v1/customers/${customerId}/ledger_summary?pricing_unit_id=${pricingUnitId}&token=${cleanToken}`;
          const ledgerResponse = await axios.get(ledgerUrl, { headers });

          // 解析剩余额度
          const creditsBalanceStr = ledgerResponse.data.credits_balance;
          if (creditsBalanceStr) {
            creditsBalance = Math.floor(parseFloat(creditsBalanceStr));
            console.log('✓ 剩余额度 (Ledger):', creditsBalance, unit);
          }
        } else {
          console.warn('⚠️  Credits 模式但未找到 Pricing Unit ID,将使用 Allocation 方式');
        }
      } catch (error) {
        console.warn('⚠️  获取 Ledger Summary 失败,将使用 Allocation 作为总额度:', error);
        // 如果获取失败,继续使用 allocation 方式
      }
    } else {
      console.log('ℹ️  User Messages 模式,跳过 Ledger API,使用 Allocation 方式');
    }

    // 调试日志: 打印最终检测结果
    console.log('\n=== 最终检测结果 ===');
    console.log('计费模式:', billingType);
    console.log('单位:', unit);
    console.log('Price ID:', currentPriceId);
    console.log('Allocation 额度:', currentAllocation);
    console.log('Ledger 剩余额度:', creditsBalance);
    console.log('===================\n');

    // 4. 获取用量信息
    if (!subscription_id || !currentPriceId) {
      console.error('错误: 未找到有效的 price_id');
      console.error('Subscription ID:', subscription_id);
      console.error('Current Price ID:', currentPriceId);
      console.error('Billing Type:', billingType);
      throw new Error(`未获取到订阅ID或价格ID (计费模式: ${billingType})`);
    }

    const usageUrl = `https://portal.withorb.com/api/v1/subscriptions/${subscription_id}/usage?price_id=${currentPriceId}&token=${cleanToken}`;
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

      if (values && values[currentPriceId] !== undefined) {
        usage = values[currentPriceId];
        used += usage;
      }

      dailyUsage.push({ date, usage });
    }

    // 计算总额度和剩余额度
    let total: number;
    let remain: number;

    if (billingType === 'credits' && creditsBalance >= 0) {
      // Credits 模式 + 成功获取 Ledger Summary: 使用剩余额度计算总额度
      remain = creditsBalance;
      total = creditsBalance + used;
      console.log('✓ 使用 Ledger 方式计算: 总额度 =', total, '(剩余', remain, '+ 已用', used, ')');
    } else {
      // User Messages 模式 或 Ledger API 失败: 使用 Allocation 方式
      // 确保有有效的 allocation 值
      if (!currentAllocation || currentAllocation === 0) {
        // 如果没有找到 allocation,使用默认值
        currentAllocation = billingType === 'credits' ? 4000 : 50;
        console.warn('⚠️  未找到有效的 Allocation,使用默认值:', currentAllocation, unit);
      }

      total = currentAllocation;
      remain = total - used;
      console.log('✓ 使用 Allocation 方式计算: 总额度 =', total, '(分配', currentAllocation, '- 已用', used, ')');
    }

    // 获取当前计费周期信息
    const currentBillingPeriod = activePriceIntervals.length > 0 ? {
      start: utcToBeijing(activePriceIntervals[0].current_billing_period_start_date),
      end: utcToBeijing(activePriceIntervals[0].current_billing_period_end_date)
    } : undefined;

    // 返回格式化的使用量信息
    return {
      email,

      // 新增字段
      billingType,
      totalAmount: total,
      usedAmount: used,
      remainingAmount: remain,
      unit,

      // 保留旧字段(向下兼容)
      totalTokens: total,
      usedTokens: used,
      remainingTokens: remain,

      registrationDate: regDate,
      expirationDate: expDate,
      dailyUsage,

      // TODO: 添加模型使用分布(需要额外 API 调用)
      modelUsage: billingType === 'credits' ? {
        sonnet: 0,
        haiku: 0,
        gpt5: 0
      } : undefined,

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

  // 根据计费模式动态生成标题和单位
  const isCreditsMode = usageInfo.billingType === 'credits';
  const chartTitle = isCreditsMode
    ? '当前账单周期用量（Credits）'
    : '当前账单周期用量（User Message）';
  const usageUnit = usageInfo.unit;

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
        <td>计费类型</td>
        <td>${isCreditsMode ? '<strong style="color: #6366f1;">Credits 模式</strong>' : 'User Messages 模式'}</td>
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
        <td><strong>${usageInfo.totalAmount.toLocaleString()} ${usageUnit}</strong></td>
      </tr>
      <tr>
        <td>已用</td>
        <td><strong style="color: #ef4444;">${usageInfo.usedAmount.toLocaleString()} ${usageUnit}</strong></td>
      </tr>
      <tr>
        <td>剩余</td>
        <td><strong style="color: #10b981;">${usageInfo.remainingAmount.toLocaleString()} ${usageUnit}</strong></td>
      </tr>
    </table>

    <div class="progress-container">
      <div class="progress-bar" style="width: ${(usageInfo.usedAmount / usageInfo.totalAmount) * 100}%"></div>
    </div>

    <div class="usage-text">
      已使用 ${usageInfo.usedAmount.toLocaleString()} / ${usageInfo.totalAmount.toLocaleString()} ${usageUnit} (${((usageInfo.usedAmount / usageInfo.totalAmount) * 100).toFixed(2)}%)
    </div>

    <div class="chart-section">
      <div class="chart-title">${chartTitle}</div>
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
  stopAutoRefresh();
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
