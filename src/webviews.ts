import type { GitCommitStat } from './types.js';

// ====================== Webview HTML 构建 ======================

export function buildWebviewHtml(data: { filePath: string; commits: GitCommitStat[] }): string {
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
export function buildCommitHistoryHtml(data: { filePath: string; commits: GitCommitStat[]; branches: string[] }): string {
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
