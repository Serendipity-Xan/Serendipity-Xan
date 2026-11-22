// 生成 GitHub 个人主页的自定义统计卡片（0-profile-details.svg 与 3-stats.svg）。
// 参考 tommywutong/profile-summary-card 的实现改写，配色沿用 tokyonight 主题。
// 运行环境：GitHub Actions 的 Node 24，需要 GITHUB_TOKEN 环境变量以提高 API 限额。
import {mkdir, writeFile} from "node:fs/promises";

// 要统计的 GitHub 用户名，改用户名时只需改这里与两个 workflow 里的 USERNAME。
const username = "Serendipity-Xan";
// 卡片输出目录，与 README 中 ./profile-summary-card-output/tokyonight/ 的引用路径对应。
const outputDirectory = "profile-summary-card-output/tokyonight";
// GitHub Actions 自动注入的令牌，用于提升 REST API 调用配额。
const token = process.env.GITHUB_TOKEN;

// tokyonight 配色：title 标题色、text 正文色、background 卡片底色、border 描边色、accent 强调色。
const colors = {
  title: "#70a5fd",
  text: "#38bdae",
  background: "#1a1b27",
  border: "#1a1b27",
  accent: "#bf91f3",
};

// 转义 XML 特殊字符，防止用户名、仓库描述中的 & < > 破坏 SVG 结构。
function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// 将大数字缩写成 1.2k / 3.4m 形式，避免卡片文字溢出。参数 value 为非负整数。
function abbreviate(value) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

// 带重试的 fetch：遇到 429 或 5xx 时最多重试 3 次，间隔 1s、2s 递增。
// 返回原始 Response；4xx（除 429）直接返回交给调用方判断。
async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

// 请求 GitHub REST API 并解析 JSON。
// path 为 / 开头的接口路径；authenticated 为 true 时附带令牌，非公开接口必须为 true。
async function fetchGitHubJson(path, {authenticated = true} = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Serendipity-Xan-profile-summary",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (authenticated && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchWithRetry(`https://api.github.com${path}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  return response.json();
}

// 抓取某一年的公开贡献日历（GitHub 网页版而非 API，因为 contribution 数据不在 REST API 中）。
// year 为四位年份；返回 [{date: 'YYYY-MM-DD', count: number}, ...]。
// 解析方式：从 HTML 里的 <tool-tip for=id> 取「N contributions」文案，再按格子 id 配对。
async function fetchPublicContributionYear(year) {
  const query = new URLSearchParams({
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  const response = await fetchWithRetry(
    `https://github.com/users/${username}/contributions?${query}`,
    {headers: {"User-Agent": "Serendipity-Xan-profile-summary"}},
  );
  if (!response.ok) {
    throw new Error(`Contribution calendar ${response.status} for ${year}`);
  }

  const html = await response.text();
  const tooltips = new Map();
  const tooltipPattern =
    /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (const match of html.matchAll(tooltipPattern)) {
    tooltips.set(match[1], match[2].trim());
  }

  const contributions = [];
  const cellPattern =
    /<td\b[^>]*\bclass="[^"]*ContributionCalendar-day[^"]*"[^>]*><\/td>/g;
  for (const match of html.matchAll(cellPattern)) {
    const cell = match[0];
    const date = cell.match(/\bdata-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const id = cell.match(/\bid="([^"]+)"/)?.[1];
    if (!date || !id) continue;

    const label = tooltips.get(id) ?? "";
    const countText = label.match(/^([\d,]+) contributions?\b/)?.[1];
    contributions.push({
      date,
      count: countText ? Number(countText.replaceAll(",", "")) : 0,
    });
  }

  if (contributions.length === 0) {
    throw new Error(`No public contribution cells found for ${year}`);
  }
  return contributions;
}

// 分页拉取当前用户名下全部公开仓库（最多 1000 个），返回仓库对象数组。
// 用于统计总 star 数，因此必须包含 fork 之外的全部自有仓库。
async function fetchAllPublicRepos() {
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await fetchGitHubJson(
      `/users/${username}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  return repositories;
}

// 用 GitHub 搜索接口统计提交/PR/Issue 数量，返回 total_count。
// query 为搜索语法字符串；endpoint 为 issues（默认，含 PR）或 commits。
// 搜索接口不需要令牌，因此这里 authenticated: false，避免与用户私有数据混淆。
async function fetchSearchCount(query, endpoint = "issues") {
  const encoded = encodeURIComponent(query);
  const result = await fetchGitHubJson(
    `/search/${endpoint}?q=${encoded}&per_page=1`,
    {authenticated: false},
  );
  return result.total_count;
}

// 把账号注册时间换算成「N years/months/days ago」的英文短语，用于资料卡。
// createdAt 为 ISO 时间字符串；now 为当前 Date。
function joinedAgo(createdAt, now) {
  const created = new Date(createdAt);
  let months =
    (now.getUTCFullYear() - created.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    created.getUTCMonth();
  if (now.getUTCDate() < created.getUTCDate()) months -= 1;

  if (months >= 12) {
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }
  if (months > 0) return `${months} month${months === 1 ? "" : "s"} ago`;

  const days = Math.max(
    0,
    Math.floor((now.getTime() - created.getTime()) / 86_400_000),
  );
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// 生成统一外框的 SVG：圆角矩形 + 字体样式，body 为内部图形片段。
// label 用于无障碍读屏；width/height 为卡片像素尺寸。
function cardFrame({width, height, label, body}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">
  <style>
    text { font-family: "Segoe UI", Ubuntu, "Helvetica Neue", sans-serif; }
  </style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="5" fill="${colors.background}" stroke="${colors.border}" />
  ${body}
</svg>
`;
}

// 渲染「Stats」小卡片：逐行列出各项指标。
// stats 为 [{label: string, value: number}]，行高固定 25px，卡片高 200px 最多容纳 5 行。
function renderStatsCard(stats) {
  const rows = stats
    .map((item, index) => {
      const y = 76 + index * 25;
      return `<g transform="translate(30 ${y})">
    <circle cx="7" cy="-5" r="6" fill="${colors.accent}" opacity="0.22" />
    <circle cx="7" cy="-5" r="2.5" fill="${colors.accent}" />
    <text x="22" y="0" font-size="14" fill="${colors.text}">${escapeXml(item.label)}</text>
    <text x="145" y="0" font-size="14" fill="${colors.text}">${escapeXml(abbreviate(item.value))}</text>
  </g>`;
    })
    .join("\n  ");

  return cardFrame({
    width: 340,
    height: 200,
    label: `${username} public GitHub statistics`,
    body: `<text x="30" y="40" font-size="22" fill="${colors.title}">Stats</text>
  ${rows}`,
  });
}

// 渲染「资料详情」大卡片：左侧文字指标，右侧近 12 个月贡献折线图。
// user 为 /users/{name} 的返回；contributions 为两年贡献日数据；now 为当前时间。
function renderProfileCard({user, contributions, now}) {
  // 以当前月份往前推 11 个月，共 12 个自然月作为横轴
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  );
  const months = Array.from({length: 12}, (_, index) => {
    const date = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + index, 1),
    );
    return {
      key: date.toISOString().slice(0, 7),
      label: date.toLocaleString("en", {month: "short", timeZone: "UTC"}),
      count: 0,
    };
  });
  // 按月汇总贡献数，忽略未来日期（时区导致的日历尾部空格子）
  const monthByKey = new Map(months.map((month) => [month.key, month]));
  const todayKey = now.toISOString().slice(0, 10);
  for (const contribution of contributions) {
    if (contribution.date > todayKey) continue;
    const month = monthByKey.get(contribution.date.slice(0, 7));
    if (month) month.count += contribution.count;
  }

  const total = months.reduce((sum, month) => sum + month.count, 0);
  // 折线图绘图区（SVG 坐标系），左右留出文字区
  const chart = {left: 292, right: 665, top: 58, bottom: 148};
  const maximum = Math.max(1, ...months.map((month) => month.count));
  const points = months.map((month, index) => {
    const x =
      chart.left + (index / (months.length - 1)) * (chart.right - chart.left);
    const y =
      chart.bottom - (month.count / maximum) * (chart.bottom - chart.top);
    return {x, y, ...month};
  });
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  // 面积路径：折线路径再闭合到底边
  const area = `M${chart.left} ${chart.bottom} ${line.replace(/^M/, "L")} L${chart.right} ${chart.bottom} Z`;
  // 三条水平参考线（0、50%、100%）
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const y = chart.bottom - ratio * (chart.bottom - chart.top);
      return `<line x1="${chart.left}" y1="${y}" x2="${chart.right}" y2="${y}" stroke="${colors.text}" opacity="0.12" />`;
    })
    .join("\n  ");
  // 月份标签隔月显示，避免拥挤
  const labels = points
    .filter((_, index) => index % 2 === 0)
    .map(
      (point) =>
        `<text x="${point.x}" y="171" text-anchor="middle" font-size="10" fill="${colors.text}" opacity="0.8">${point.label}</text>`,
    )
    .join("\n  ");

  const title = user.name ? `${username} (${user.name})` : username;
  const details = [
    `${abbreviate(total)} contributions in 12 months`,
    `${abbreviate(user.public_repos)} public repositories`,
    `Joined GitHub ${joinedAgo(user.created_at, now)}`,
  ];
  if (user.location) {
    details.push(user.location.replace(/\s*,\s*/g, ", "));
  }

  // 左上角最多四行指标，每行 28px
  const detailRows = details
    .slice(0, 4)
    .map(
      (value, index) => `<g transform="translate(30 ${76 + index * 28})">
    <circle cx="7" cy="-5" r="6" fill="${colors.accent}" opacity="0.22" />
    <circle cx="7" cy="-5" r="2.5" fill="${colors.accent}" />
    <text x="22" y="0" font-size="14" fill="${colors.text}">${escapeXml(value)}</text>
  </g>`,
    )
    .join("\n  ");

  return cardFrame({
    width: 700,
    height: 200,
    label: `${username} visible GitHub profile summary`,
    body: `<text x="30" y="40" font-size="22" fill="${colors.title}">${escapeXml(title)}</text>
  ${detailRows}
  ${grid}
  <path d="${area}" fill="${colors.accent}" opacity="0.22" />
  <path d="${line}" fill="none" stroke="${colors.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
  ${labels}`,
  });
}

// 入口：并发拉取用户资料、仓库、搜索计数与两年贡献数据，再写两张 SVG。
// 任何一步失败都会抛出异常使 Action 失败，避免把错误内容写入卡片。
async function main() {
  const now = new Date();
  // 跨年时 12 个月窗口会跨越两个自然年，因此拉两年数据再合并
  const years = [now.getUTCFullYear() - 1, now.getUTCFullYear()];
  const [user, repositories, commits, pullRequests, issues, ...yearData] =
    await Promise.all([
      fetchGitHubJson(`/users/${username}`),
      fetchAllPublicRepos(),
      fetchSearchCount(`author:${username}`, "commits"),
      fetchSearchCount(`author:${username} type:pr`),
      fetchSearchCount(`author:${username} type:issue`),
      ...years.map(fetchPublicContributionYear),
    ]);

  const stats = [
    {
      label: "Total Stars:",
      value: repositories.reduce(
        (sum, repository) => sum + repository.stargazers_count,
        0,
      ),
    },
    {label: "Public Commits:", value: commits},
    {label: "Public PRs:", value: pullRequests},
    {label: "Public Issues:", value: issues},
    {label: "Public Repos:", value: user.public_repos},
  ];

  await mkdir(outputDirectory, {recursive: true});
  await Promise.all([
    writeFile(
      `${outputDirectory}/0-profile-details.svg`,
      renderProfileCard({
        user,
        contributions: yearData.flat(),
        now,
      }),
    ),
    writeFile(
      `${outputDirectory}/3-stats.svg`,
      renderStatsCard(stats),
    ),
  ]);
}

await main();
