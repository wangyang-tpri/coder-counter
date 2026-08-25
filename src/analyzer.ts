import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CountResult, HistoryItem } from './types.js';


export function parseContent(content: string): { code: number; comment: number; blank: number } {
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

export async function walkDir(dirPath: string, output: vscode.OutputChannel, fileTableRows: string[], result: CountResult) {
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

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh‑CN');
}

export function diffResult(prev: CountResult | undefined, curr: CountResult): string {
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

export function buildCsv(history: HistoryItem[]): string {
  const header = "时间,路径,文件数,总行数,有效代码行,注释行,空行,时间戳\n";
  const rows = history.map(item => {
    const p = `"${item.targetPath.replace(/"/g, '""')}"`;
    return `${item.humanTime},${p},${item.fileCount},${item.totalLines},${item.codeLines},${item.commentLines},${item.blankLines},${item.timestamp}`;
  });
  return header + rows.join("\n");
}
