import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

interface CountResult {
  fileCount: number;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

interface HistoryItem extends CountResult {
  timestamp: number;
  humanTime: string;
  targetPath: string;
}

interface ExtensionGlobalState {
  historyList: HistoryItem[];
}

// git单条提交信息
interface GitLineCommitInfo {
  lineNumber: number;
  shortHash: string;
  author: string;
  subject: string;
  fullHash: string;
}

// 文件的某次git提交记录及其对应行数统计
interface GitCommitStat {
  hash: string;
  shortHash: string;
  author: string;
  dateLabel: string;
  dateTs: number;
  subject: string;
  stats: CountResult;
  isWorkingTree: boolean; // 是否为"当前工作区"合成记录
}

// ====================== 新增 Git 工具封装 开始 ======================
const execAsync = promisify(exec);

/**
 * 获取文件所属Git仓库根目录
 * @param fileUri 文件Uri
 * @returns 仓库绝对路径 | null（不在git仓库返回null）
 */
async function getGitRepoRoot(fileUri: vscode.Uri): Promise<string | null> {
  try {
    // 修复：git -C 只能传入目录，取文件所在文件夹
    const fileDir = path.dirname(fileUri.fsPath);
    const { stdout } = await execAsync(`git -C "${fileDir}" rev-parse --show-toplevel`);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * 获取文件相对于Git仓库根目录的相对路径
 * @param repoRoot Git仓库根目录
 * @param fileUri 文件Uri
 * @returns 仓库内相对路径（适配Windows / Mac / Linux）
 */
function getRepoRelativePath(repoRoot: string, fileUri: vscode.Uri): string {
  // git输出根路径通常使用正斜杠，而 fsPath 是反斜杠，统一后再匹配
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = fileUri.fsPath.replace(/\\/g, '/');
  let relative: string;
  // Windows盘符可能大小写不一致，不区分大小写匹配
  if (abs.toLowerCase().startsWith(root.toLowerCase())) {
    relative = abs.slice(root.length);
  } else {
    relative = abs.replace(root, '');
  }
  // 清理开头分隔符，git统一使用 /
  return relative.replace(/^[\\/]/, '').replace(/\\/g, '/');
}



/**
 * 安全执行Git命令
 * @param cwd 执行目录（Git仓库根）
 * @param cmd git完整命令
 * @returns 命令stdout结果
 */
async function runGitCmd(cwd: string, cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      timeout: 10000 // 超时10秒防止卡死
    });
    return stdout.trim();
  } catch (err: any) {
    throw new Error(err.stderr || err.message);
  }
}
// ====================== 新增 Git 工具封装 结束 ======================

// ====================== 自定义 Git 历史内容提供器（修复 vscode.diff 无法读取 git scheme 文件） ======================
// 内置 git 扩展的 git:// scheme 要求特定内部格式且依赖其已加载的仓库，
// 这里注册一个自有 scheme，通过 `git show <hash>:<path>` 直接读取历史版本内容。
const DIFF_SCHEME = 'code-counter-git';

/**
 * 读取指定提交下某文件的历史内容
 * @param repoRoot 仓库根目录
 * @param relativePath 仓库内相对路径
 * @param hash 提交hash
 * @returns 文件内容
 */
async function getFileContentAtCommit(repoRoot: string, relativePath: string, hash: string): Promise<string> {
  const { stdout } = await execAsync(`git show "${hash}:${relativePath}"`, {
    cwd: repoRoot,
    timeout: 10000,
    maxBuffer: 100 * 1024 * 1024 // 100MB，防止大文件超出默认1MB缓冲
  });
  return stdout;
}

/**
 * 计算文本的行数统计
 */
function computeStats(content: string): CountResult {
  const { code, comment, blank } = parseContent(content);
  const total = code + comment + blank;
  return { fileCount: 1, totalLines: total, codeLines: code, commentLines: comment, blankLines: blank };
}

/**
 * 格式化提交时间戳为可读字符串
 */
function formatCommitDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 获取某文件的git提交记录，并逐条计算文件在每次提交时的行数统计。
 * 最后追加一条"当前工作区"合成记录，保证图表打开即有数据。
 * @param repoRoot 仓库根目录
 * @param fileUri 文件Uri
 * @returns 按时间从旧到新排序的提交统计列表
 */
async function getFileCommitStats(repoRoot: string, fileUri: vscode.Uri): Promise<GitCommitStat[]> {
  const relativePath = getRepoRelativePath(repoRoot, fileUri);

  // 读取该文件的提交记录（新→旧），%x1e 作字段分隔符，避免摘要含逗号等干扰
  const logOut = await runGitCmd(repoRoot, `git log --format=%H%x1e%an%x1e%ad%x1e%s --date=iso-strict -n 100 -- "${relativePath}"`);

  const result: GitCommitStat[] = [];
  if (logOut) {
    const records = logOut.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\x1e');
      const hash = parts[0];
      const author = parts[1] || '';
      const dateTs = new Date(parts[2]).getTime();
      const subject = parts.slice(3).join('\x1e');
      return { hash, author, dateTs, subject };
    });
    for (const r of records) {
      try {
        const content = await getFileContentAtCommit(repoRoot, relativePath, r.hash);
        result.push({
          hash: r.hash,
          shortHash: r.hash.substring(0, 7),
          author: r.author,
          dateLabel: formatCommitDate(r.dateTs),
          dateTs: r.dateTs,
          subject: r.subject,
          stats: computeStats(content),
          isWorkingTree: false
        });
      } catch {
        // 该提交读不到文件内容（如该提交恰好删除了文件），跳过
      }
    }
  }

  // 追加当前工作区状态（保证图表初始化即有数据）
  try {
    const current = await fs.promises.readFile(fileUri.fsPath, 'utf8');
    result.push({
      hash: '',
      shortHash: '工作区',
      author: '当前状态',
      dateLabel: '当前工作区',
      dateTs: Date.now(),
      subject: '当前工作区文件状态',
      stats: computeStats(current),
      isWorkingTree: true
    });
  } catch {
    // 文件读取失败（如已删除），忽略
  }

  // 提交记录 git log 返回新→旧，翻转成旧→新作为x轴趋势
  return result.sort((a, b) => a.dateTs - b.dateTs);
}

/**
 * 获取某文件的git提交记录（仅元数据，不计算行数，速度快）
 * 支持按分支、作者、日期范围筛选
 * @param repoRoot 仓库根目录
 * @param fileUri 文件Uri
 * @param opts 筛选条件：all=所有分支，ref=指定分支名，author=作者关键词，since/until=日期范围
 * @returns 提交记录列表（新→旧）
 */
async function getFileCommitList(repoRoot: string, fileUri: vscode.Uri, opts?: { all?: boolean; ref?: string; author?: string; since?: string; until?: string }): Promise<GitCommitStat[]> {
  const relativePath = getRepoRelativePath(repoRoot, fileUri);
  let ref = '';
  if (opts?.all) ref = ' --all';
  else if (opts?.ref) ref = ` ${opts.ref}`;
  const author = opts?.author ? ` --author="${opts.author}"` : '';
  const since = opts?.since ? ` --since="${opts.since}"` : '';
  const until = opts?.until ? ` --until="${opts.until}"` : '';
  const logOut = await runGitCmd(repoRoot, `git log --format=%H%x1e%an%x1e%ad%x1e%s --date=iso-strict${ref}${author}${since}${until} -- "${relativePath}"`);
  const result: GitCommitStat[] = [];
  if (logOut) {
    for (const line of logOut.split('\n').filter(Boolean)) {
      const parts = line.split('\x1e');
      const hash = parts[0];
      const dateTs = new Date(parts[2]).getTime();
      result.push({
        hash,
        shortHash: hash.substring(0, 7),
        author: parts[1] || '',
        dateLabel: formatCommitDate(dateTs),
        dateTs,
        subject: parts.slice(3).join('\x1e'),
        stats: { fileCount: 0, totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0 },
        isWorkingTree: false
      });
    }
  }
  return result;
}

/**
 * 获取某提交涉及的所有文件路径
 * @param repoRoot 仓库根目录
 * @param hash 提交hash
 * @returns 文件路径列表
 */
async function getFilesInCommit(repoRoot: string, hash: string): Promise<string[]> {
  const out = await runGitCmd(repoRoot, `git show --name-only --format= ${hash}`);
  return out.split('\n').filter(Boolean);
}

/**
 * 获取仓库所有本地分支名
 * @param repoRoot 仓库根目录
 * @returns 分支名列表
 */
async function getBranchList(repoRoot: string): Promise<string[]> {
  try {
    const out = await runGitCmd(repoRoot, 'git branch --format=%(refname:short)');
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 文本内容提供器：为自定义 scheme 提供“提交历史版本”的文件内容，
 * 使 vscode.diff 能读取左侧（旧版本）文件。
 * URI 约定：scheme=code-counter-git，path=文件绝对路径，query=提交hash
 */
class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const fileUri = vscode.Uri.from({ scheme: 'file', path: uri.path });
    const hash = uri.query;
    if (!hash) {
      throw new Error('缺少提交hash参数');
    }
    const repoRoot = await getGitRepoRoot(fileUri);
    if (!repoRoot) {
      throw new Error('文件不在Git仓库中');
    }
    const relativePath = getRepoRelativePath(repoRoot, fileUri);
    return getFileContentAtCommit(repoRoot, relativePath, hash);
  }
}
// ====================== 自定义 Git 历史内容提供器 结束 ======================

function parseContent(content: string): { code: number; comment: number; blank: number } {
  const lines = content.split(/\r?\n/);
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlockComment = false;

  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.length === 0) {
      blank++;
      continue;
    }
    if (inBlockComment) {
      comment++;
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) inBlockComment = false;
      continue;
    }
    const blockStart = line.indexOf('/*');
    const lineComment = line.indexOf('//');
    if (blockStart !== -1) {
      comment++;
      const endIdx = line.indexOf('*/', blockStart + 2);
      if (endIdx === -1) inBlockComment = true;
      continue;
    }
    if (lineComment === 0) {
      comment++;
      continue;
    }
    code++;
  }
  return { code, comment, blank };
}

async function walkDir(dirPath: string, output: vscode.OutputChannel, fileTableRows: string[], result: CountResult) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'out'].includes(entry.name)) continue;
      await walkDir(full, output, fileTableRows, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const allowExt = new Set([
        '.ts', '.js', '.tsx', '.jsx', '.java', '.c', '.cpp', '.h', '.hpp',
        '.py', '.go', '.rs', '.vue', '.html', '.css', '.scss'
      ]);
      if (!allowExt.has(ext)) continue;
      try {
        const buf = await fs.promises.readFile(full, 'utf8');
        const { code, comment, blank } = parseContent(buf);
        const total = code + comment + blank;
        result.fileCount += 1;
        result.totalLines += total;
        result.codeLines += code;
        result.commentLines += comment;
        result.blankLines += blank;
        // 单行表格行：文件名 | 总行 | 代码行 | 注释行 | 空行
        fileTableRows.push(`| ${entry.name} | ${total} | ${code} | ${comment} | ${blank} |`);
      } catch (e) {
        output.appendLine(`skip read file: ${full}`);
      }
    }
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh‑CN');
}

function diffResult(prev: CountResult | undefined, curr: CountResult): string {
  if (!prev) return "无历史对比数据";
  const dfFile = curr.fileCount - prev.fileCount;
  const dfTotal = curr.totalLines - prev.totalLines;
  const dfCode = curr.codeLines - prev.codeLines;
  const dfComment = curr.commentLines - prev.commentLines;
  const dfBlank = curr.blankLines - prev.blankLines;
  const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return `
=====与上一次快照对比=====
文件数: ${fmt(dfFile)}
总行数: ${fmt(dfTotal)}
有效代码行: ${fmt(dfCode)}
注释行: ${fmt(dfComment)}
空行: ${fmt(dfBlank)}
`.trim();
}

function buildCsv(history: HistoryItem[]): string {
  const header = "时间,路径,文件数,总行数,有效代码行,注释行,空行,时间戳\n";
  const rows = history.map(item => {
    const p = `"${item.targetPath.replace(/"/g, '""')}"`;
    return `${item.humanTime},${p},${item.fileCount},${item.totalLines},${item.codeLines},${item.commentLines},${item.blankLines},${item.timestamp}`;
  });
  return header + rows.join("\n");
}

function buildWebviewHtml(data: { filePath: string; commits: GitCommitStat[] }): string {
  // 转义 < 防止路径/摘要包含 </script> 破坏页面
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>代码量统计图表</title>
<style>
body {background:#1e1e1e;color:#ccc;padding:12px;font-family:system-ui}
h2,h3 {margin:8px 0}
.file-path {color:#888;font-size:11px;margin-bottom:4px;word-break:break-all}
#chart {width:100%;height:500px}
.chart-msg {color:#f0a020;padding:16px;border:1px dashed #666;display:none;margin:8px 0}
table {border-collapse:collapse;width:100%;margin:10px 0;font-size:12px}
th,td {border:1px solid #444;padding:6px 8px;text-align:left;white-space:nowrap}
th {background:#333;position:sticky;top:0}
tbody tr {cursor:pointer}
tbody tr:hover {background:#2a2d2e}
tbody tr.active {background:#37373d;outline:1px solid #0e639c}
tbody tr.worktree td:first-child {color:#4fc1ff}
.hint {color:#888;font-size:11px;margin-left:6px}
.subj-cell {max-width:360px;overflow:hidden;text-overflow:ellipsis}
</style>
</head>
<body>
<h2>📈 代码量变更趋势图表</h2>
<div class="file-path" id="filePathLabel"></div>
<div id="chart"></div>
<div id="chartMsg" class="chart-msg">⚠️ 图表库（ECharts）加载失败，请检查网络后重新打开。提交记录列表不受影响，可正常查看。</div>
<h3>Git提交记录 <span class="hint">点击某条记录，上方图表画出标记线并高亮该提交</span></h3>
<div class="hint" id="selInfo"></div>
<table>
<thead><tr><th>提交</th><th>作者</th><th>时间</th><th>摘要</th><th>总行数</th><th>代码行</th><th>注释行</th><th>空行</th></tr></thead>
<tbody id="listBody"></tbody>
</table>
<script>
const data = ${dataJson};
const listBody = document.getElementById('listBody');
const chartEl = document.getElementById('chart');
const chartMsg = document.getElementById('chartMsg');
const filePathLabel = document.getElementById('filePathLabel');
const selInfo = document.getElementById('selInfo');
let myChart = null;
let activeIdx = -1;

filePathLabel.textContent = data.filePath;
if (data.commits.length > 0) {
  activeIdx = data.commits.length - 1; // 默认高亮最新一条（含"工作区"）
}

// ---------- 渲染提交记录列表（不依赖图表库，始终可用） ----------
function renderList() {
  if (data.commits.length === 0) {
    listBody.innerHTML = '<tr><td colspan="8" style="color:#888">该文件暂无git提交记录（可能是未跟踪的新文件）。</td></tr>';
    selInfo.textContent = '';
    return;
  }
  listBody.innerHTML = data.commits.map((c, idx) => \`
    <tr data-idx="\${idx}" class="\${idx === activeIdx ? 'active' : ''}\${c.isWorkingTree ? ' worktree' : ''}">
      <td title="\${c.hash}">\${c.shortHash}</td>
      <td>\${c.author}</td>
      <td>\${c.dateLabel}</td>
      <td class="subj-cell" title="\${c.subject}">\${c.subject}</td>
      <td>\${c.stats.totalLines}</td>
      <td>\${c.stats.codeLines}</td>
      <td>\${c.stats.commentLines}</td>
      <td>\${c.stats.blankLines}</td>
    </tr>\`).join('');
  listBody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      activeIdx = Number(tr.dataset.idx);
      renderList();
      renderChart();
    });
  });
}

// ---------- 渲染趋势图（仅在ECharts可用时生效） ----------
function renderChart() {
  if (!myChart) return;
  if (data.commits.length === 0) { myChart.clear(); selInfo.textContent = ''; return; }
  const commits = data.commits;
  const idx = Math.max(0, activeIdx);
  const series = [
    {name:'总行数', type:'line', data:commits.map(c=>c.stats.totalLines)},
    {name:'有效代码行', type:'line', data:commits.map(c=>c.stats.codeLines)},
    {name:'注释行', type:'line', data:commits.map(c=>c.stats.commentLines)},
    {name:'空行', type:'line', data:commits.map(c=>c.stats.blankLines)}
  ];
  // 在选中的提交处画标记线（只在"总行数"系列上画一次，避免重复）
  const markLine = {
    symbol:'none',
    silent:true,
    label:{ color:'#4fc1ff', formatter: commits[idx].shortHash + ' ' + commits[idx].dateLabel },
    lineStyle:{ color:'#4fc1ff', width:2 },
    data:[{ xAxis: idx }]
  };
  const option = {
    tooltip:{ trigger:'axis' },
    legend:{ data:['总行数','有效代码行','注释行','空行'] },
    grid:{ left:70, right:40, top:40, bottom:60 },
    xAxis:{ type:'category', data:commits.map(c=>c.shortHash), axisLabel:{ rotate:45 } },
    yAxis:{ type:'value' },
    series: series.map((s, si) => si === 0 ? {...s, markLine} : s)
  };
  myChart.setOption(option, true);
  selInfo.textContent = \`已选中 \${commits[idx].shortHash}（\${commits[idx].dateLabel}），共 \${commits.length} 条\`;
}

renderList();
renderChart(); // myChart未初始化时为no-op

// ---------- ECharts加载（多CDN备用，全部失败则提示，不影响列表） ----------
function initChart() {
  myChart = echarts.init(chartEl, 'dark');
  window.addEventListener('resize', () => myChart.resize());
  renderChart();
}
const sources = [
  'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js',
  'https://unpkg.com/echarts@5.4.3/dist/echarts.min.js',
  'https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js'
];
function tryLoad(i) {
  if (i >= sources.length) { chartMsg.style.display = 'block'; return; }
  const s = document.createElement('script');
  s.src = sources[i];
  s.onload = () => initChart();
  s.onerror = () => tryLoad(i + 1);
  document.head.appendChild(s);
}
tryLoad(0);
</script>
</body>
</html>
`;
}

// 构建"文件提交历史"Webview页面：顶部筛选栏（日期/分支/作者），左侧提交列表，点击提交后右侧显示涉及文件，点击文件直接打开该文件的提交差异
function buildCommitHistoryHtml(data: { filePath: string; commits: GitCommitStat[]; branches: string[] }): string {
  // 转义 < 防止路径/摘要包含 </script> 破坏页面
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>文件提交历史</title>
<style>
* {box-sizing:border-box}
body {margin:0;background:#1e1e1e;color:#ccc;font-family:system-ui;display:flex;flex-direction:column;height:100vh}
.header {padding:10px 14px;border-bottom:1px solid #333;font-size:13px;display:flex;align-items:center;gap:10px}
.header .path {color:#888;word-break:break-all;flex:1}
.header .count {color:#4fc1ff;white-space:nowrap}
.filterbar {padding:8px 14px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.filterbar label {color:#9aa0a6}
.filterbar input, .filterbar select {background:#252526;color:#ccc;border:1px solid #3c3c3c;padding:4px 6px;border-radius:3px;font-size:12px}
.filterbar button {background:#0e639c;color:#fff;border:none;padding:4px 14px;border-radius:3px;cursor:pointer;font-size:12px}
.filterbar button:hover {background:#1177bb}
.filterbar button.secondary {background:#333;border:1px solid #3c3c3c}
.filterbar button.secondary:hover {background:#3d3d3d}
.main {flex:1;display:flex;min-height:0}
.left {width:42%;border-right:1px solid #333;overflow-y:auto}
.right {flex:1;overflow-y:auto;padding:10px 14px}
.commit-item {padding:8px 12px;border-bottom:1px solid #2a2a2a;cursor:pointer}
.commit-item:hover {background:#2a2d2e}
.commit-item.active {background:#37373d;outline:1px solid #0e639c}
.commit-item .top {display:flex;justify-content:space-between;gap:8px}
.commit-item .hash {color:#4fc1ff;font-family:Consolas,monospace;font-size:12px}
.commit-item .date {color:#888;font-size:11px;white-space:nowrap}
.commit-item .subject {margin-top:2px;font-size:13px;color:#ddd;word-break:break-all}
.commit-item .author {color:#9aa0a6;font-size:11px;margin-top:2px}
.placeholder {color:#888;text-align:center;margin-top:40px}
.file-item {padding:6px 10px;border-bottom:1px solid #2a2a2a;font-family:Consolas,monospace;font-size:12px;word-break:break-all;cursor:pointer;display:flex;align-items:center;gap:6px}
.file-item:hover {background:#2a2d2e}
.file-item .icon {color:#4fc1ff;font-size:11px;flex-shrink:0}
.section-title {color:#4fc1ff;margin:12px 0 6px;font-size:12px}
</style>
</head>
<body>
<div class="header">
  <span>📜 文件提交历史</span>
  <span class="path" id="filePathLabel"></span>
  <span class="count" id="countLabel"></span>
</div>
<div class="filterbar">
  <label>日期</label>
  <input type="date" id="fromInput" title="开始日期">
  <span style="color:#888">至</span>
  <input type="date" id="toInput" title="结束日期">
  <label>分支</label>
  <select id="branchSelect"></select>
  <label>作者</label>
  <input type="text" id="authorInput" placeholder="作者关键词" style="width:130px">
  <button id="queryBtn">查询</button>
  <button id="resetBtn" class="secondary">清空</button>
</div>
<div class="main">
  <div class="left" id="commitList"></div>
  <div class="right" id="fileList"><div class="placeholder">点击左侧提交记录，查看该提交涉及的所有文件</div></div>
</div>
<script>
const data = ${dataJson};
const vscode = acquireVsCodeApi();
const commitList = document.getElementById('commitList');
const fileList = document.getElementById('fileList');
const countLabel = document.getElementById('countLabel');
const fromInput = document.getElementById('fromInput');
const toInput = document.getElementById('toInput');
const branchSelect = document.getElementById('branchSelect');
const authorInput = document.getElementById('authorInput');
const queryBtn = document.getElementById('queryBtn');
const resetBtn = document.getElementById('resetBtn');
document.getElementById('filePathLabel').textContent = data.filePath;
let activeHash = '';

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderBranchSelect() {
  let html = '<option value="__head__">当前分支</option>';
  (data.branches || []).forEach(b => { html += '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + '</option>'; });
  html += '<option value="__all__">所有分支</option>';
  branchSelect.innerHTML = html;
}

function currentFilters() {
  return {
    all: branchSelect.value === '__all__',
    ref: (branchSelect.value === '__all__' || branchSelect.value === '__head__') ? '' : branchSelect.value,
    author: authorInput.value.trim(),
    since: fromInput.value,
    until: toInput.value
  };
}

function runQuery() {
  vscode.postMessage({ type: 'query', ...currentFilters() });
}

// 重置所有查询条件并重新查询
function resetFilters() {
  fromInput.value = '';
  toInput.value = '';
  authorInput.value = '';
  branchSelect.value = '__head__';
  runQuery();
}

function updateCount() {
  countLabel.textContent = data.commits.length > 0 ? \`共 \${data.commits.length} 条提交\` : '共 0 条提交';
}

function renderCommits() {
  if (data.commits.length === 0) {
    commitList.innerHTML = '<div class="placeholder">没有符合筛选条件的提交记录</div>';
    fileList.innerHTML = '<div class="placeholder">点击左侧提交记录，查看该提交涉及的所有文件</div>';
    return;
  }
  commitList.innerHTML = data.commits.map(c => \`
    <div class="commit-item" data-hash="\${c.hash}">
      <div class="top"><span class="hash">\${c.shortHash}</span><span class="date">\${c.dateLabel}</span></div>
      <div class="subject">\${c.subject}</div>
      <div class="author">\${c.author}</div>
    </div>\`).join('');
  commitList.querySelectorAll('.commit-item').forEach(el => {
    el.addEventListener('click', () => {
      commitList.querySelectorAll('.commit-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      activeHash = el.dataset.hash;
      fileList.innerHTML = '<div class="placeholder">加载中…</div>';
      vscode.postMessage({ type: 'getFiles', hash: activeHash });
    });
  });
}

function renderFiles(files) {
  if (!files || files.length === 0) {
    fileList.innerHTML = '<div class="placeholder">该提交未涉及文件变更</div>';
    return;
  }
  fileList.innerHTML = '<div class="section-title">涉及文件（' + files.length + '，点击文件打开该提交的差异）</div>' + files.map(f =>
    '<div class="file-item" data-file="' + encodeURIComponent(f) + '"><span class="icon">🔀</span>' + escapeHtml(f) + '</div>').join('');
  fileList.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'openDiff', file: decodeURIComponent(el.dataset.file), hash: activeHash });
    });
  });
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'files' && msg.hash === activeHash) {
    renderFiles(msg.files);
  } else if (msg.type === 'commits') {
    data.commits = msg.commits || [];
    activeHash = '';
    updateCount();
    renderCommits();
  }
});

renderBranchSelect();
updateCount();
renderCommits();
queryBtn.addEventListener('click', runQuery);
resetBtn.addEventListener('click', resetFilters);
authorInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runQuery(); });
branchSelect.addEventListener('change', runQuery);
</script>
</body>
</html>
`;
}


// 执行git命令包装（保留原有，给blame继续使用）
function execGit(cwd:string, cmd:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    exec(cmd,{cwd, maxBuffer: 100 * 1024 * 1024},(err,stdout,stderr)=>{
      if(err) return reject(err);
      resolve(stdout);
    })
  })
}

// 获取文件每一行git blame信息
async function getFileBlame(filePath:string):Promise<GitLineCommitInfo[]>{
  const dir = path.dirname(filePath);
  try{
    const relFile = path.relative(dir,filePath);
    const out = await execGit(dir,`git blame --porcelain "${relFile}"`);
    const lines = out.replace(/\r/g,'').split('\n');
    const result:GitLineCommitInfo[]=[];
    let lineNum = 0;
    let hash = '';
    let author = '';
    let subject = '';
    for(const l of lines){
      if(/^[0-9a-f]{40} /.test(l)){
        const parts = l.split(' ');
        hash = parts[0];
        lineNum = parseInt(parts[2],10);
        continue;
      }
      if(l.startsWith('author ')){
        author = l.replace(/^author /,'');
        continue;
      }
      if(l.startsWith('summary ')){
        subject = l.replace(/^summary /,'');
        continue;
      }
      if(l.startsWith('\t')){
        // 代码行输出，组装一条记录
        // 注意：不要清空 hash/author/subject —— porcelain 格式中同一提交的多行
        // 只输出一次元数据，后续行需沿用上一次的 author/subject
        result.push({
          lineNumber: lineNum,
          shortHash: hash.substring(0,7),
          fullHash: hash,
          author,
          subject
        })
      }
    }
    return result;
  }catch(e){
    return [];
  }
}

export function activate(context: vscode.ExtensionContext) {
  const GLOBAL_KEY = "codeCounterStore";

  // ===== Git blame 光标行提示（行尾装饰，GitLens风格）=====
  // 光标所在行的代码末尾显示「短hash 作者 · 摘要」，光标移走即消失；悬停该行可查看详情并点击打开差异
  const blameLineDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1.5em',
      color: new vscode.ThemeColor('editorGhostText.foreground')
    }
  });

  // blame结果缓存，按文件修改时间判断是否需要重新执行git blame
  let blameCache: { fsPath: string; mtimeMs: number; list: GitLineCommitInfo[] } | null = null;
  // 同一文件并发blame请求去重（避免光标快速移动时重复执行git命令）
  let blameInFlight: { fsPath: string; promise: Promise<GitLineCommitInfo[]> } | null = null;

  async function getBlameList(fsPath: string): Promise<GitLineCommitInfo[]> {
    if (blameInFlight && blameInFlight.fsPath === fsPath) return blameInFlight.promise;
    const promise = (async () => {
      try {
        const stat = await fs.promises.stat(fsPath);
        if (blameCache && blameCache.fsPath === fsPath && blameCache.mtimeMs === stat.mtimeMs) {
          return blameCache.list;
        }
        const list = await getFileBlame(fsPath);
        blameCache = { fsPath, mtimeMs: stat.mtimeMs, list };
        return list;
      } catch {
        if (blameCache && blameCache.fsPath === fsPath) blameCache = null;
        return [];
      } finally {
        if (blameInFlight && blameInFlight.fsPath === fsPath) blameInFlight = null;
      }
    })();
    blameInFlight = { fsPath, promise };
    return promise;
  }

  // 记录当前装饰了哪个编辑器，切换时清空旧装饰
  let blameDecoratedEditor: vscode.TextEditor | null = null;

  // 在光标所在行末尾绘制blame装饰。list为null表示blame尚未加载完成（先不画）
  function applyBlameDecoration(editor: vscode.TextEditor, fsPath: string, lineNum: number, list: GitLineCommitInfo[] | null) {
    // 光标已离开该文件或该行时不更新
    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line + 1 !== lineNum) return;
    const line = editor.document.lineAt(lineNum - 1);
    const item = list ? list.find(i => i.lineNumber === lineNum) : undefined;
    if (!item) {
      // blame无数据（文件未跟踪/不在仓库/无提交），行尾给个可见提示
      editor.setDecorations(blameLineDecoration, [{
        range: line.range,
        renderOptions: { after: { contentText: '（该行无Git提交信息）' } }
      }]);
      return;
    }
    const subject = item.subject.length > 30 ? item.subject.substring(0, 30) + '…' : item.subject;
    const content = ` ${item.shortHash} ${item.author} · ${subject}`;
    const args = encodeURIComponent(JSON.stringify([{ file: fsPath, hash: item.fullHash }]));
    const historyArgs = encodeURIComponent(JSON.stringify([{ file: fsPath }]));
    const chartArgs = encodeURIComponent(JSON.stringify([{ file: fsPath }]));
    const hover = new vscode.MarkdownString();
    hover.appendMarkdown(`**提交** \`${item.fullHash}\`  \n\n**作者** ${item.author}  \n**摘要** ${item.subject}  \n\n[🔀](command:code-counter.openFileGitDiff?${args} "查看提交差异")  [📜](command:code-counter.openFileCommitHistory?${historyArgs} "查看文件提交历史")  [📈](command:code-counter.openChart?${chartArgs} "代码量统计图表")`);
    hover.isTrusted = true;
    editor.setDecorations(blameLineDecoration, [{
      range: line.range,
      hoverMessage: hover,
      renderOptions: { after: { contentText: content } }
    }]);
  }

  // 根据当前光标刷新行尾装饰；缓存缺失时自动后台执行blame
  function updateBlameDecoration(editor: vscode.TextEditor | undefined) {
    // 切换编辑器时先清空旧编辑器的装饰
    if (blameDecoratedEditor && blameDecoratedEditor !== editor) {
      blameDecoratedEditor.setDecorations(blameLineDecoration, []);
      blameDecoratedEditor = null;
    }
    if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') {
      return;
    }
    blameDecoratedEditor = editor;
    const fsPath = editor.document.uri.fsPath;
    const lineNum = editor.selection.active.line + 1; // blame行号从1开始
    const cached = (blameCache && blameCache.fsPath === fsPath) ? blameCache.list : null;
    applyBlameDecoration(editor, fsPath, lineNum, cached);
    if (!cached) {
      // 无缓存：后台加载blame，完成后按当时的活动编辑器/光标刷新
      getBlameList(fsPath).then(list => {
        if (vscode.window.activeTextEditor === editor) {
          applyBlameDecoration(editor, fsPath, lineNum, list);
        }
      });
    }
  }

  function loadStore(): ExtensionGlobalState {
    const raw = context.globalState.get<ExtensionGlobalState>(GLOBAL_KEY);
    if (raw && Array.isArray(raw.historyList)) return raw;
    return { historyList: [] };
  }

  function saveStore(state: ExtensionGlobalState) {
    context.globalState.update(GLOBAL_KEY, state);
  }

  // 切换编辑器：刷新行尾装饰（内部会自动加载blame）
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateBlameDecoration(editor);
  }, null, context.subscriptions);

  // 光标移动：实时刷新行尾装饰（缓存命中即显示，未命中则后台加载）
  vscode.window.onDidChangeTextEditorSelection((e) => {
    updateBlameDecoration(e.textEditor);
  }, null, context.subscriptions);

  // 文档保存后：重新blame并刷新行尾装饰
  vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file') {
      getBlameList(doc.uri.fsPath).then(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === doc.uri.toString()) {
          updateBlameDecoration(editor);
        }
      });
    }
  }, null, context.subscriptions);

  // 扩展激活时（含启动激活），若已有活动编辑器，立即刷新一次行尾装饰，无需等光标移动
  updateBlameDecoration(vscode.window.activeTextEditor);

  // ====================== 重构：打开git diff差异窗口命令（稳定版，使用自定义scheme） ======================
  // 注册自定义文本内容提供器，使vscode.diff能读取提交历史版本文件
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitRevisionContentProvider())
  );

  const openDiffCmd = vscode.commands.registerCommand('code-counter.openFileGitDiff', async (args:{file:string;hash:string})=>{
    try{
      const {file,hash}=args;
      const fileUri = vscode.Uri.file(file);

      // 1. 获取Git仓库根目录，判断是否在Git仓库
      const repoRoot = await getGitRepoRoot(fileUri);
      if (!repoRoot) {
        vscode.window.showErrorMessage("获取Git提交差异失败，请确认文件在Git仓库中。");
        return;
      }

      // 2. 获取仓库相对路径
      const relativePath = getRepoRelativePath(repoRoot, fileUri);

      // 3. 获取提交作者、摘要信息
      const commitMetaRaw = await runGitCmd(repoRoot, `git show -s --format=%an||%s ${hash}`);
      const [author, summary] = commitMetaRaw.split('||');

      // 4. 预读取历史版本内容，若失败提前提示，避免diff窗口出现“无法读取文件”
      try {
        await getFileContentAtCommit(repoRoot, relativePath, hash);
      } catch (err: any) {
        vscode.window.showErrorMessage(`读取提交 ${hash.substring(0,7)} 文件内容失败：${err.message}`);
        return;
      }

      // 左侧为自定义scheme的历史版本URI，由 GitRevisionContentProvider 提供内容
      const oldUri = fileUri.with({ scheme: DIFF_SCHEME, query: hash });
      const newUri = fileUri;

      await vscode.commands.executeCommand('vscode.diff',
        oldUri,
        newUri,
        `提交 ${hash.substring(0,7)}【${author||"未知作者"}】：${summary||""}`,
        {viewColumn:vscode.ViewColumn.Two}
      );

    }catch(err:any){
      console.error("[openFileGitDiff ERROR]", err);
      vscode.window.showErrorMessage(`打开Git差异失败：${err.message}`);
    }
  });

  // 打开"文件提交历史"窗口：左侧所有提交，点击后在右侧显示该提交涉及的文件
  const openHistoryCmd = vscode.commands.registerCommand('code-counter.openFileCommitHistory', async (args?: { file?: string }) => {
    let fileUri: vscode.Uri | undefined;
    if (args && args.file) {
      fileUri = vscode.Uri.file(args.file);
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
        fileUri = editor.document.uri;
      }
    }
    if (!fileUri) {
      vscode.window.showWarningMessage('请先打开一个文件，再查看其提交历史。');
      return;
    }
    const repoRoot = await getGitRepoRoot(fileUri);
    if (!repoRoot) {
      vscode.window.showErrorMessage(`文件不在Git仓库中，无法获取提交历史：${fileUri.fsPath}`);
      return;
    }
    const [commits, branches] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在读取提交历史...' },
      () => Promise.all([
        getFileCommitList(repoRoot, fileUri),
        getBranchList(repoRoot)
      ])
    );
    const panel = vscode.window.createWebviewPanel(
      'codeCounterCommitHistory',
      `提交历史 - ${path.basename(fileUri.fsPath)}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = buildCommitHistoryHtml({ filePath: fileUri.fsPath, commits, branches });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'getFiles' && msg.hash) {
        let files: string[] = [];
        try {
          files = await getFilesInCommit(repoRoot, msg.hash);
        } catch {
          files = [];
        }
        await panel.webview.postMessage({ type: 'files', hash: msg.hash, files });
      } else if (msg.type === 'openDiff' && msg.file && msg.hash) {
        // 点击右侧"涉及文件"：拼绝对路径后复用 openFileGitDiff 打开该文件的提交差异
        const absPath = path.join(repoRoot, msg.file);
        vscode.commands.executeCommand('code-counter.openFileGitDiff', { file: absPath, hash: msg.hash });
      } else if (msg.type === 'query') {
        // 按 日期/分支/作者 重新查询提交列表
        let queryCommits: GitCommitStat[] = [];
        try {
          queryCommits = await getFileCommitList(repoRoot, fileUri, {
            all: msg.all,
            ref: msg.ref,
            author: msg.author,
            since: msg.since,
            until: msg.until
          });
        } catch {
          queryCommits = [];
        }
        await panel.webview.postMessage({ type: 'commits', commits: queryCommits });
      }
    }, null, context.subscriptions);
  });

  const countCmd = vscode.commands.registerCommand('code-counter.countCode', async (uri: vscode.Uri) => {
    if (!uri) {
      vscode.window.showErrorMessage('请在资源管理器选中文件/文件夹右键执行');
      return;
    }
    const fsPath = uri.fsPath;
    const output = vscode.window.createOutputChannel('CodeCounter');
    output.show();

    const result: CountResult = {
      fileCount: 0,
      totalLines: 0,
      codeLines: 0,
      commentLines: 0,
      blankLines: 0
    };
    const stat = await fs.promises.stat(fsPath);
    const allowExt = new Set([
      '.ts', '.js', '.tsx', '.jsx', '.java', '.c', '.cpp', '.h', '.hpp',
      '.py', '.go', '.rs', '.vue', '.html', '.css', '.scss'
    ]);

    // 存放每个文件的表格行
    const fileTableRows: string[] = [];

    if (stat.isDirectory()) {
      await walkDir(fsPath, output, fileTableRows, result);
    } else if (stat.isFile()) {
      const ext = path.extname(fsPath);
      if (!allowExt.has(ext)) {
        output.appendLine('该后缀不在统计白名单');
        return;
      }
      const buf = await fs.promises.readFile(fsPath, 'utf8');
      const { code, comment, blank } = parseContent(buf);
      const total = code + comment + blank;
      result.fileCount = 1;
      result.totalLines = total;
      result.codeLines = code;
      result.commentLines = comment;
      result.blankLines = blank;
      fileTableRows.push(`| ${path.basename(fsPath)} | ${total} | ${code} | ${comment} | ${blank} |`);
    }

    // ========== 输出 文件明细 Markdown 表格 ==========
    output.appendLine('\n## 📄 文件明细统计表格');
    output.appendLine('| 文件名 | 总行数 | 有效代码行 | 注释行 | 空行 |');
    output.appendLine('|--------|--------|------------|--------|------|');
    output.appendLine(fileTableRows.join('\n'));

    // ========== 汇总表格 ==========
    output.appendLine('\n## 📊 汇总统计表格');
    output.appendLine('| 统计项 | 数值 |');
    output.appendLine('|--------|------|');
    output.appendLine(`| 目标路径 | ${fsPath} |`);
    output.appendLine(`| 文件总数 | ${result.fileCount} |`);
    output.appendLine(`| 总行数 | ${result.totalLines} |`);
    output.appendLine(`| 有效代码行 | ${result.codeLines} |`);
    output.appendLine(`| 注释行 | ${result.commentLines} |`);
    output.appendLine(`| 空行 | ${result.blankLines} |`);
    output.appendLine(`| 注释占比 | ${((result.commentLines / Math.max(result.totalLines,1)) * 100).toFixed(2)}% |`);

    const store = loadStore();
    const samePathHistory = store.historyList.filter(h => h.targetPath === fsPath);
    const lastOne = samePathHistory.length > 0 ? samePathHistory[samePathHistory.length -1] : undefined;
    output.appendLine("\n" + diffResult(lastOne, result));

    const nowTs = Date.now();
    const newItem: HistoryItem = { ...result, timestamp: nowTs, humanTime: formatTime(nowTs), targetPath: fsPath };
    store.historyList.push(newItem);
    if (store.historyList.length > 50) store.historyList = store.historyList.slice(-50);
    saveStore(store);
    output.appendLine(`\n✅已保存本次统计快照到变更历史`);
  });

  const clearHistoryCmd = vscode.commands.registerCommand('code-counter.clearHistory', async () => {
    const confirm = await vscode.window.showWarningMessage("确定要清空全部代码统计历史快照？不可恢复", "确定清空", "取消");
    if (confirm !== "确定清空") return;
    saveStore({ historyList: [] });
    vscode.window.showInformationMessage("已清空统计历史记录");
  });

  const exportCsvCmd = vscode.commands.registerCommand('code-counter.exportCsv', async () => {
    const store = loadStore();
    if (store.historyList.length === 0) {
      vscode.window.showWarningMessage("暂无历史快照，无法导出CSV");
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??'', 'code‑counter‑history.csv')),
      filters: { 'CSV文件': ['csv'] },
      title: "保存统计历史CSV文件"
    });
    if (!uri) return;
    const csvText = buildCsv(store.historyList);
    await fs.promises.writeFile(uri.fsPath, csvText, 'utf8');
    vscode.window.showInformationMessage(`✅CSV已导出: ${uri.fsPath}`);
  });

  const openChartCmd = vscode.commands.registerCommand('code-counter.openChart', async (args?: { file?: string }) => {
    let fileUri: vscode.Uri | undefined;
    if (args && args.file) {
      fileUri = vscode.Uri.file(args.file);
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
        fileUri = editor.document.uri;
      }
    }
    if (!fileUri) {
      vscode.window.showWarningMessage('请先在编辑器中打开一个文件，再执行“CodeCounter: 打开统计图表”。');
      return;
    }
    const repoRoot = await getGitRepoRoot(fileUri);
    if (!repoRoot) {
      vscode.window.showErrorMessage(`文件不在Git仓库中，无法获取提交记录：${fileUri.fsPath}`);
      return;
    }

    const commits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在读取Git提交记录并统计行数...' },
      () => getFileCommitStats(repoRoot, fileUri)
    );

    const panel = vscode.window.createWebviewPanel(
      'codeCounterChart',
      `代码量统计图表 - ${path.basename(fileUri.fsPath)}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = buildWebviewHtml({ filePath: fileUri.fsPath, commits });
  });

  context.subscriptions.push(
    countCmd, clearHistoryCmd, exportCsvCmd, openChartCmd, openDiffCmd, openHistoryCmd, blameLineDecoration
  );
}

export function deactivate() {}