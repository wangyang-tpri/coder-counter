import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CountResult, ExtensionGlobalState, GitCommitStat, HistoryItem } from './types.js';
import {
  getGitRepoRoot,
  getRepoRelativePath,
  runGitCmd,
  getFileContentAtCommit,
  getFileCommitStats,
  getFileCommitList,
  getFilesInCommit,
  getBranchList,
  DIFF_SCHEME
} from './git.js';
import { walkDir, parseContent, formatTime, diffResult, buildCsv } from './analyzer.js';
import { collectCodeFiles, buildWordHtml } from './wordExport.js';
import { buildWebviewHtml, buildCommitHistoryHtml } from './webviews.js';

export function registerCommands(context: vscode.ExtensionContext) {
  const GLOBAL_KEY = "codeCounterStore";

  function loadStore(): ExtensionGlobalState {
    const raw = context.globalState.get<ExtensionGlobalState>(GLOBAL_KEY);
    if (raw && Array.isArray(raw.historyList)) return raw;
    return { historyList: [] };
  }

  function saveStore(state: ExtensionGlobalState) {
    context.globalState.update(GLOBAL_KEY, state);
  }

  const openDiffCmd = vscode.commands.registerCommand('code-counter.openFileGitDiff', async (args: { file: string; hash: string }) => {
    try {
      const { file, hash } = args;
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
        vscode.window.showErrorMessage(`读取提交 ${hash.substring(0, 7)} 文件内容失败：${err.message}`);
        return;
      }

      // 左侧为自定义scheme的历史版本URI，由 GitRevisionContentProvider 提供内容
      const oldUri = fileUri.with({ scheme: DIFF_SCHEME, query: hash });
      const newUri = fileUri;

      await vscode.commands.executeCommand('vscode.diff',
        oldUri,
        newUri,
        `提交 ${hash.substring(0, 7)}【${author || "未知作者"}】：${summary || ""}`,
        { viewColumn: vscode.ViewColumn.Two }
      );

    } catch (err: any) {
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

    output.appendLine('\n## 📄 文件明细统计表格');
    output.appendLine('| 文件名 | 总行数 | 有效代码行 | 注释行 | 空行 |');
    output.appendLine('|--------|--------|------------|--------|------|');
    output.appendLine(fileTableRows.join('\n'));

    output.appendLine('\n## 📊 汇总统计表格');
    output.appendLine('| 统计项 | 数值 |');
    output.appendLine('|--------|------|');
    output.appendLine(`| 目标路径 | ${fsPath} |`);
    output.appendLine(`| 文件总数 | ${result.fileCount} |`);
    output.appendLine(`| 总行数 | ${result.totalLines} |`);
    output.appendLine(`| 有效代码行 | ${result.codeLines} |`);
    output.appendLine(`| 注释行 | ${result.commentLines} |`);
    output.appendLine(`| 空行 | ${result.blankLines} |`);
    output.appendLine(`| 注释占比 | ${((result.commentLines / Math.max(result.totalLines, 1)) * 100).toFixed(2)}% |`);

    const store = loadStore();
    const samePathHistory = store.historyList.filter(h => h.targetPath === fsPath);
    const lastOne = samePathHistory.length > 0 ? samePathHistory[samePathHistory.length - 1] : undefined;
    output.appendLine("\n" + diffResult(lastOne, result));

    const nowTs = Date.now();
    const newItem: HistoryItem = { ...result, timestamp: nowTs, humanTime: formatTime(nowTs), targetPath: fsPath };
    store.historyList.push(newItem);
    if (store.historyList.length > 50) store.historyList = store.historyList.slice(-50);
    saveStore(store);
    output.appendLine(`\n✅已保存本次统计快照到变更历史`);
  });

  // 导出选中文件/文件夹的代码为Word文档（入口与"统计代码行数"一致：资源管理器右键）
  const exportWordCmd = vscode.commands.registerCommand('code-counter.exportWord', async (uri: vscode.Uri) => {
    if (!uri) {
      vscode.window.showErrorMessage('请在资源管理器选中文件/文件夹右键执行');
      return;
    }
    const fsPath = uri.fsPath;
    const files = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在收集代码文件...' },
      () => collectCodeFiles(fsPath)
    );
    if (files.length === 0) {
      vscode.window.showInformationMessage('未找到符合后缀的代码文件（白名单：TS/JS/Java/C/CPP/Python/Go/Rust/Vue/HTML/CSS 等），已跳过导出。');
      return;
    }
    const defaultName = path.basename(fsPath) + '-代码导出.doc';
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(fsPath), defaultName)),
      filters: { 'Word 文档 (*.doc)': ['doc'] },
      saveLabel: '导出'
    });
    if (!saveUri) return;
    const html = buildWordHtml(fsPath, files);
    await fs.promises.writeFile(saveUri.fsPath, html, 'utf8');
    const open = await vscode.window.showInformationMessage(
      `✅ 已导出 ${files.length} 个代码文件到 ${saveUri.fsPath}`,
      '打开文档'
    );
    if (open === '打开文档') {
      vscode.env.openExternal(saveUri);
    }
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
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', 'code‑counter‑history.csv')),
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
    countCmd, clearHistoryCmd, exportCsvCmd, exportWordCmd, openChartCmd, openDiffCmd, openHistoryCmd
  );
}
