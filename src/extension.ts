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

function buildWebviewHtml(list: HistoryItem[]): string {
  const dataJson = JSON.stringify(list);
  return `
<!DOCTYPE html>
<html lang="zh‑CN">
<head>
<meta charset="UTF‑8">
<meta name="viewport" content="width=device‑width,initial‑scale=1.0">
<title>代码量统计图表</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
<style>
body {background:#1e1e1e;color:#ccc;padding:12px;font‑family:system‑ui}
#chart {width:100%;height:500px}
pre {font‑size:11px;overflow‑x:auto;background:#2d2d2d;padding:8px}
table {border-collapse: collapse;width:100%;margin:10px 0}
th,td {border:1px solid #444;padding:6px 8px;text-align:left}
th {background:#333}
</style>
</head>
<body>
<h2>📈 代码量变更趋势图表</h2>
<div id="chart"></div>
<h3>历史快照列表</h3>
<pre id="list"></pre>
<script>
const raw = ${dataJson};
const chartDom = document.getElementById('chart');
const myChart = echarts.init(chartDom, 'dark');

const xAxisData = raw.map(i=>i.humanTime);
const series = [
  {name:'文件数',type:'line',data:raw.map(i=>i.fileCount)},
  {name:'总行数',type:'line',data:raw.map(i=>i.totalLines)},
  {name:'有效代码行',type:'line',data:raw.map(i=>i.codeLines)},
  {name:'注释行',type:'line',data:raw.map(i=>i.commentLines)},
  {name:'空行',type:'line',data:raw.map(i=>i.blankLines)}
];

const option = {
  tooltip:{trigger:'axis'},
  legend:{data:series.map(s=>s.name)},
  xAxis:{type:'category',data:xAxisData,axisLabel:{rotate:30}},
  yAxis:{type:'value'},
  series
};
myChart.setOption(option);
window.addEventListener('resize',()=>myChart.resize());

const preDom = document.getElementById('list');
preDom.innerText = raw.map((item,idx)=>
\`[\${idx+1}] \${item.humanTime} | \${item.targetPath}
文件:\${item.fileCount} 总行:\${item.totalLines} 代码:\${item.codeLines} 注释:\${item.commentLines} 空行:\${item.blankLines}\`
).join('\\n\\n');
</script>
</body>
</html>
`;
}

// 执行git命令包装（保留原有，给blame继续使用）
function execGit(cwd:string, cmd:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    exec(cmd,{cwd},(err,stdout,stderr)=>{
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
    const lines = out.split('\n');
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
        result.push({
          lineNumber: lineNum,
          shortHash: hash.substring(0,7),
          fullHash: hash,
          author,
          subject
        })
        hash='';author='';subject='';
      }
    }
    return result;
  }catch(e){
    return [];
  }
}

export function activate(context: vscode.ExtensionContext) {
  const GLOBAL_KEY = "codeCounterStore";

  // 行尾装饰器，浅色提示
  const gitDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      textDecoration: 'none; opacity: 0.45; margin: 0 8px;'
    }
  });

  let activeEditor: vscode.TextEditor | undefined;

  function loadStore(): ExtensionGlobalState {
    const raw = context.globalState.get<ExtensionGlobalState>(GLOBAL_KEY);
    if (raw && Array.isArray(raw.historyList)) return raw;
    return { historyList: [] };
  }

  function saveStore(state: ExtensionGlobalState) {
    context.globalState.update(GLOBAL_KEY, state);
  }

  // 更新编辑器git blame行提示
  async function updateGitBlameDecorations(editor:vscode.TextEditor){
    if(!editor.document.isUntitled && editor.document.uri.scheme === 'file'){
      const fsPath = editor.document.uri.fsPath;
      const blameList = await getFileBlame(fsPath);
      const decorations:vscode.DecorationOptions[]=[];
      for(const item of blameList){
        const ln = item.lineNumber -1;
        if(ln <0 || ln >= editor.document.lineCount) continue;
        const line = editor.document.lineAt(ln);
        const pos = new vscode.Position(ln, line.text.length);
        const hoverMsg = new vscode.MarkdownString();
        const args = JSON.stringify({file:fsPath,hash:item.fullHash});
        hoverMsg.appendMarkdown(`**Commit ${item.shortHash}**\n\n作者：${item.author}\n\n摘要：${item.subject}\n\n[点击查看提交差异](command:code-counter.openFileGitDiff?${encodeURIComponent(args)})`);
        hoverMsg.isTrusted = true;
        decorations.push({
          range: new vscode.Range(pos,pos),
          hoverMessage: hoverMsg,
          renderOptions:{
            after:{
              contentText:`  ${item.shortHash} ${item.subject.substring(0,22)}${item.subject.length>22?'…':''}`
            }
          }
        })
      }
      editor.setDecorations(gitDecorationType,decorations);
    }
  }

  // 切换编辑器触发刷新
  vscode.window.onDidChangeActiveTextEditor(async (editor)=>{
    activeEditor = editor;
    if(editor){
      await updateGitBlameDecorations(editor);
    }
  },null,context.subscriptions);

  // 文档保存后刷新blame
  vscode.workspace.onDidSaveTextDocument(async (doc)=>{
    if(activeEditor && activeEditor.document.uri.toString() === doc.uri.toString()){
      await updateGitBlameDecorations(activeEditor);
    }
  },null,context.subscriptions);

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

  const showHistoryCmd = vscode.commands.registerCommand('code-counter.showHistory', () => {
    const store = loadStore();
    const output = vscode.window.createOutputChannel('CodeCounter‑History');
    output.show(true);
    output.appendLine("# 📜 代码统计历史快照表格");
    output.appendLine("| 序号 | 统计时间 | 路径 | 文件数 | 总行数 | 有效代码行 | 注释行 | 空行 |");
    output.appendLine("|------|----------|------|--------|--------|------------|--------|------|");
    if (store.historyList.length === 0) {
      output.appendLine("暂无历史快照，请先执行一次代码统计");
      return;
    }
    store.historyList.forEach((item, idx) => {
      output.appendLine(`| ${idx+1} | ${item.humanTime} | ${item.targetPath} | ${item.fileCount} | ${item.totalLines} | ${item.codeLines} | ${item.commentLines} | ${item.blankLines} |`);
    });
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

  const openChartCmd = vscode.commands.registerCommand('code-counter.openChart', () => {
    const store = loadStore();
    const panel = vscode.window.createWebviewPanel('codeCounterChart', '代码量统计图表', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = buildWebviewHtml(store.historyList);
  });

  context.subscriptions.push(
    countCmd, showHistoryCmd, clearHistoryCmd, exportCsvCmd, openChartCmd, openDiffCmd, gitDecorationType
  );
}

export function deactivate() {}