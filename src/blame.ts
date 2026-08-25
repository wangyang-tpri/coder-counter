import * as vscode from 'vscode';
import * as fs from 'fs';
import type { GitLineCommitInfo } from './types.js';
import { getFileBlame } from './git.js';

// 光标所在行的代码末尾显示「短hash 作者 · 摘要」，光标移走即消失；悬停该行可查看详情并点击打开差异
export function registerBlameFeature(context: vscode.ExtensionContext) {
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
    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line + 1 !== lineNum) return;
    const line = editor.document.lineAt(lineNum - 1);
    const item = list ? list.find(i => i.lineNumber === lineNum) : undefined;
    if (!item) {
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
      getBlameList(fsPath).then(list => {
        if (vscode.window.activeTextEditor === editor) {
          applyBlameDecoration(editor, fsPath, lineNum, list);
        }
      });
    }
  }

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateBlameDecoration(editor);
  }, null, context.subscriptions);

  vscode.window.onDidChangeTextEditorSelection((e) => {
    updateBlameDecoration(e.textEditor);
  }, null, context.subscriptions);

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

  updateBlameDecoration(vscode.window.activeTextEditor);

  context.subscriptions.push(blameLineDecoration);
}
