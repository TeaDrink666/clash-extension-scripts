// FlClash 版本：各机场统一为七个代理组。
// 脚本保留 IPv6、DNS 等默认配置；最终是否被覆盖取决于客户端设置。
function main(config, profileName) {
  const names = ['手动选择', '自动选择', '优选自动', '故障转移', '优选均衡', 'AI', '低倍率优选自动'];
  const url = 'https://www.gstatic.com/generate_204';
  const region = [
    '香港|澳门|澳門|台湾|台灣|臺灣|台北|臺北|高雄|新北',
    '🇭🇰|🇲🇴|🇹🇼|(?i:hong[ _-]*kong|maca[ou]|taiwan|taipei)',
    '(?i:(^|[^a-z])(hk|hkg|mo|mac|tw|twn)([^a-z]|$))'
  ].join('|');
  const info = '剩余|剩餘|流量|到期|有效期|套餐|重置|官网|官網|订阅|訂閱';
  const infoRE = new RegExp(info);
  // 低倍率按名称中的标记识别：0.1倍率、0.01倍率等，要求大于 0 且小于 1。
  // 未标倍率、1倍率及更高倍率不加入；这里只识别标记，不查询机场计费。
  const lowRate = '(^|[^0-9.])0\\.[0-9]*[1-9][0-9]*\\s*倍率';
  const lowRateRE = new RegExp(lowRate);
  // JS 和 Mihomo 的正则语法不同：显式节点用 JS 正则，集合用 region。
  const regionRE = /香港|澳门|澳門|台湾|台灣|臺灣|台北|臺北|高雄|新北|🇭🇰|🇲🇴|🇹🇼|hong[ _-]*kong|maca[ou]|taiwan|taipei|(^|[^a-z])(hk|hkg|mo|mac|tw|twn)([^a-z]|$)/i;
  const nodes = (config.proxies || []).filter(p =>
    p && typeof p.name === 'string' && !infoRE.test(p.name)
  );
  const nodeNames = nodes.map(p => p.name);
  if (new Set(nodeNames).size !== nodeNames.length) {
    throw new Error('节点名称重复，请先为重复节点改名。');
  }
  if (nodeNames.some(n => names.includes(n))) {
    throw new Error('节点名称与统一代理组同名，请先重命名该节点。');
  }
  const providers = config['proxy-providers'] || {};
  // 空的内联集合不能被 Mihomo 加载；移除后再生成所有组的 use 列表。
  for (const key of Object.keys(providers)) {
    if (providers[key].type === 'inline' &&
        Array.isArray(providers[key].payload) && !providers[key].payload.length) {
      delete providers[key];
    }
  }
  const providerNames = Object.keys(providers);
  if (!nodeNames.length && !providerNames.length) {
    throw new Error('没有节点或代理集合，请确认脚本执行顺序。');
  }
  const automaticNodes = nodeNames;
  const nonRegionalNodes = automaticNodes.filter(n => !regionRE.test(n));
  const lowRateNodes = nonRegionalNodes.filter(n => lowRateRE.test(n));
  if (!nonRegionalNodes.length && !providerNames.length) {
    throw new Error('没有非港澳台节点，无法创建优选自动和优选均衡组。');
  }
  // 链式节点的拨号依赖必须仍然存在。仅将原组中唯一且确定的出口展开，
  // 多出口组不擅自改选，也不映射到包含当前节点的统一组，以免产生循环。
  const originalGroups = new Map(
    (config['proxy-groups'] || []).map(group => [group.name, group])
  );
  const builtInDialers = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE']);
  function resolveDialer(target, visited = new Set()) {
    if (builtInDialers.has(target) || nodeNames.includes(target)) return target;
    if (visited.has(target)) throw new Error('链式代理依赖循环：' + target);
    const group = originalGroups.get(target);
    const choices = group && Array.isArray(group.proxies) ? [...new Set(group.proxies)] : [];
    if (!group || !['select', 'url-test', 'fallback', 'load-balance'].includes(group.type) ||
        choices.length !== 1 || (group.use && group.use.length) ||
        group.filter || group['exclude-filter'] || group['exclude-type'] ||
        group['include-all'] || group['include-all-proxies'] || group['include-all-providers']) {
      throw new Error('链式代理依赖“' + target + '”无法保留：请将 dialer-proxy 指定为明确的节点名称。');
    }
    const next = new Set(visited);
    next.add(target);
    return resolveDialer(choices[0], next);
  }
  function normalizeDialer(item) {
    if (!item['dialer-proxy']) return;
    const target = resolveDialer(item['dialer-proxy']);
    if (target === 'DIRECT') delete item['dialer-proxy'];
    else item['dialer-proxy'] = target;
  }
  for (const node of nodes) normalizeDialer(node);
  const nodesByName = new Map(nodes.map(node => [node.name, node]));
  const completed = new Set();
  function checkChain(name, visiting = new Set()) {
    if (visiting.has(name)) throw new Error('链式代理节点依赖循环：' + name);
    if (completed.has(name)) return;
    const target = nodesByName.get(name)['dialer-proxy'];
    if (nodesByName.has(target)) {
      visiting.add(name);
      checkChain(target, visiting);
      visiting.delete(name);
    }
    completed.add(name);
  }
  for (const name of nodeNames) checkChain(name);
  // 集合内节点由集合的健康检查负责测速。
  for (const key of providerNames) {
    const provider = providers[key];
    normalizeDialer(provider);
    if (Array.isArray(provider.payload)) {
      for (const node of provider.payload) normalizeDialer(node);
    }
    provider['health-check'] = {
      ...(provider['health-check'] || {}),
      enable: true, url, interval: 300, lazy: false
    };
    // 集合下载若引用原机场组，改为直连，避免删除原组后的悬空引用。
    if (provider.proxy && !nodeNames.includes(provider.proxy) &&
        !['DIRECT', 'REJECT'].includes(provider.proxy)) {
      provider.proxy = 'DIRECT';
    }
  }
  function automatic(name, type, proxies, exclude) {
    const group = {
      name, type, proxies: [...proxies], url,
      interval: 300, lazy: false, 'exclude-filter': exclude,
      // 正常有节点时不影响选择；集合更新后若意外变空，拒绝请求而不自动直连。
      'empty-fallback': 'REJECT'
    };
    if (providerNames.length) group.use = [...providerNames];
    if (type === 'url-test') group.tolerance = 50;
    return group;
  }
  const manual = {
    name: names[0], type: 'select',
    proxies: [names[2], names[6], names[1], names[3], names[4], ...nodeNames, 'DIRECT'],
    'exclude-filter': info
  };
  if (providerNames.length) manual.use = [...providerNames];
  const ai = {
    name: names[5], type: 'select',
    proxies: [names[0], names[2], names[6], names[1], names[3], names[4], ...nodeNames, 'DIRECT'],
    'exclude-filter': info
  };
  if (providerNames.length) ai.use = [...providerNames];
  config.proxies = nodes;
  config['proxy-groups'] = [
    manual,
    automatic(names[2], 'url-test', nonRegionalNodes, [info, region].join('|')),
    {
      ...automatic(names[6], 'url-test',
        lowRateNodes.length || providerNames.length ? lowRateNodes : ['REJECT'],
        [info, region].join('|')),
      // 显式节点已在 JS 中筛选；filter 负责筛选通过 use 引入的集合节点。
      // 无匹配节点时沿用 empty-fallback: REJECT，不混入普通倍率节点。
      filter: lowRate
    },
    automatic(names[1], 'url-test', automaticNodes, info),
    automatic(names[3], 'fallback', automaticNodes, info),
    {
      ...automatic(names[4], 'load-balance', nonRegionalNodes, [info, region].join('|')),
      strategy: 'consistent-hashing'
    },
    ai
  ];
  // 国内及局域网直连，其余交给手动选择。
  // GEOSITE / GEOIP 依赖客户端地理数据库，首次使用可能需要下载。
  // Mihomo 默认设置：请同时检查 FlClash 的对应选项及覆写设置。
  // TCP 并发和统一延迟用于改善连接与测速的可比性。
  config['tcp-concurrent'] = true;
  config['unified-delay'] = true;
  // 不使用 IPv6：同时关闭核心 IPv6 和 DNS 的 AAAA 解析。
  config.ipv6 = false;
  // 不允许其他局域网设备连接本机代理。
  config['allow-lan'] = false;
  config['geo-auto-update'] = true;
  config['geo-update-interval'] = 24;
  config.profile = {
    ...(config.profile || {}),
    'store-selected': true
  };
  // 保留机场原有 nameserver / fallback；关闭 IPv6 和 DNS 遵循规则，
  // 避免 DNS 查询依赖当前代理节点。客户端覆写可能改变最终生效值。
  config.dns = {
    ...(config.dns || {}),
    enable: true,
    ipv6: false,
    'respect-rules': false,
  };
  config.mode = 'rule';
  // 机场额外规则：原来的“一分机场”统一映射为“手动选择”。
  // 下列规则优先于后面的国内/局域网默认规则，按从上到下的顺序匹配。
  // DIRECT = 直连；手动选择 = 跟随该组当前选择的节点或子组。
  // DOMAIN = 仅匹配这个完整域名；DOMAIN-SUFFIX = 匹配域名及其子域名。
  const customPrependRules = [
    // Google Gemini：网页、AI Studio 与开发者入口。
    'DOMAIN-SUFFIX,gemini.google.com,AI',
    'DOMAIN-SUFFIX,gemini.google,AI',
    'DOMAIN-SUFFIX,aistudio.google.com,AI',
    'DOMAIN-SUFFIX,ai.google.dev,AI',

    // Google Antigravity 与相关 AI API：独立匹配，避免接管整个 googleapis.com。
    // 这些请求统一使用 AI 组；分流正确不代表账号资格或出口地区一定可用。
    'DOMAIN-SUFFIX,antigravity.google,AI',
    'DOMAIN,daily-cloudcode-pa.googleapis.com,AI',
    'DOMAIN,cloudcode-pa.googleapis.com,AI',
    'DOMAIN,aicode.googleapis.com,AI',
    'DOMAIN,businessaicode.googleapis.com,AI',
    'DOMAIN,generativelanguage.googleapis.com,AI',

    // Grok：网页及 x.ai 域名（含其 API 子域名）。
    'DOMAIN-SUFFIX,grok.com,AI',
    'DOMAIN-SUFFIX,x.ai,AI',

    // Claude / Anthropic：网页及 API 子域名。
    'DOMAIN-SUFFIX,claude.ai,AI',
    'DOMAIN-SUFFIX,anthropic.com,AI',

    // 其他 AI 服务：Perplexity 与 NotebookLM。
    'DOMAIN-SUFFIX,perplexity.ai,AI',
    'DOMAIN-SUFFIX,notebooklm.google.com,AI',

    // AI 比价网：priceai.cc 及其子域名直连。
    'DOMAIN-SUFFIX,priceai.cc,DIRECT',

    // API 中转站：lyy.team、zyzy111.xyz 及其子域名直连。
    'DOMAIN-SUFFIX,lyy.team,DIRECT',
    'DOMAIN-SUFFIX,zyzy111.xyz,DIRECT',

    // API 中转站 umapis.com：sub 子域名单独走代理，其余域名直连。
    // 特例必须放在通用 umapis.com 规则前，否则会被后者匹配为直连。
    'DOMAIN,sub.umapis.com,手动选择',
    'DOMAIN-SUFFIX,umapis.com,DIRECT',

    // API 中转站 rtoc.cc：域名及其子域名直连。
    'DOMAIN-SUFFIX,rtoc.cc,DIRECT',

    // 我的个人网站 bxr0ask.asia：域名及其子域名直连。
    'DOMAIN-SUFFIX,bxr0ask.asia,DIRECT',

    // Bing：本人主要使用搜索功能，bing.com 及其子域名统一直连。
    'DOMAIN-SUFFIX,bing.com,DIRECT',

    // Steam 下载相关：下列内容分发、服务器及客户端下载域名走直连。
    // client-download 特例需位于下方 steampowered.com 通用代理规则之前。
    'DOMAIN-SUFFIX,steamcontent.com,DIRECT',
    'DOMAIN-SUFFIX,steamserver.net,DIRECT',
    'DOMAIN,client-download.steampowered.com,DIRECT',
    'DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,DIRECT',

    // Steam 商店、社区、静态资源、聊天及 Valve 官网等：走“手动选择”组。
    // steampowered.com 下除上方已匹配的下载特例外，其余子域名走代理。
    'DOMAIN,store.steampowered.com,手动选择',
    'DOMAIN-SUFFIX,steamcommunity.com,手动选择',
    'DOMAIN-SUFFIX,steampowered.com,手动选择',
    'DOMAIN-SUFFIX,steamstatic.com,手动选择',
    'DOMAIN-SUFFIX,steam-chat.com,手动选择',
    'DOMAIN-SUFFIX,valvesoftware.com,手动选择'
  ];
  config.rules = [
    ...customPrependRules,
    'DOMAIN,localhost,DIRECT',
    'DOMAIN-SUFFIX,local,DIRECT',
    'DOMAIN-SUFFIX,lan,DIRECT',
    'DOMAIN-SUFFIX,home.arpa,DIRECT',
    'IP-CIDR,0.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,224.0.0.0/4,DIRECT,no-resolve',
    'IP-CIDR6,::/128,DIRECT,no-resolve',
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
    'IP-CIDR6,ff00::/8,DIRECT,no-resolve',
    'GEOSITE,cn,DIRECT',
    'GEOIP,CN,DIRECT',
    'MATCH,手动选择'
  ];
  // 原规则集合可能仍被 DNS 使用，保留定义但不沿用原来的路由规则。
  delete config['sub-rules'];
  return config;
}
