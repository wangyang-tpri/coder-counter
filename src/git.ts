import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { CountResult, GitCommitStat, GitLineCommitInfo } from './types.js';
import { parseContent } from './analyzer.js';

const execAsync = promisify(exec);

/**
 * 获取文件所属Git仓库根目录
 * @param fileUri 文件Uri
 * @returns 仓库绝对路径 | null（不在git仓库返回null）
 */
export async function getGitRepoRoot(fileUri: vscode.Uri): Promise<string | null> {
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
export function getRepoRelativePath(repoRoot: string, fileUri: vscode.Uri): string {
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
export async function runGitCmd(cwd: string, cmd: string): Promise<string> {
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

export const DIFF_SCHEME = 'code-counter-git';

/**
 * 读取指定提交下某文件的历史内容
 * @param repoRoot 仓库根目录
 * @param relativePath 仓库内相对路径
 * @param hash 提交hash
 * @returns 文件内容
 */
export async function getFileContentAtCommit(repoRoot: string, relativePath: string, hash: string): Promise<string> {
  const { stdout } = await execAsync(`git show "${hash}:${relativePath}"`, {
    cwd: repoRoot,
    timeout: 10000,
    maxBuffer: 100 * 1024 * 1024 // 100MB，防止大文件超出默认1MB缓冲
  });
  return stdout;
}

/**
 * 计算文本的行数统计（模块私有）
 */
function computeStats(content: string): CountResult {
  const { code, comment, blank } = parseContent(content);
  const total = code + comment + blank;
  return { fileCount: 1, totalLines: total, codeLines: code, commentLines: comment, blankLines: blank };
}

/**
 * 格式化提交时间戳为可读字符串（模块私有）
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
export async function getFileCommitStats(repoRoot: string, fileUri: vscode.Uri): Promise<GitCommitStat[]> {
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
export async function getFileCommitList(repoRoot: string, fileUri: vscode.Uri, opts?: { all?: boolean; ref?: string; author?: string; since?: string; until?: string }): Promise<GitCommitStat[]> {
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
export async function getFilesInCommit(repoRoot: string, hash: string): Promise<string[]> {
  const out = await runGitCmd(repoRoot, `git show --name-only --format= ${hash}`);
  return out.split('\n').filter(Boolean);
}

/**
 * 获取仓库所有本地分支名
 * @param repoRoot 仓库根目录
 * @returns 分支名列表
 */
export async function getBranchList(repoRoot: string): Promise<string[]> {
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
export class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
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

// 执行git命令包装（保留原有，给blame继续使用）
export function execGit(cwd: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// 获取文件每一行git blame信息
export async function getFileBlame(filePath: string): Promise<GitLineCommitInfo[]> {
  const dir = path.dirname(filePath);
  try {
    const relFile = path.relative(dir, filePath);
    const out = await execGit(dir, `git blame --porcelain "${relFile}"`);
    const lines = out.replace(/\r/g, '').split('\n');
    const result: GitLineCommitInfo[] = [];
    let lineNum = 0;
    let hash = '';
    let author = '';
    let subject = '';
    for (const l of lines) {
      if (/^[0-9a-f]{40} /.test(l)) {
        const parts = l.split(' ');
        hash = parts[0];
        lineNum = parseInt(parts[2], 10);
        continue;
      }
      if (l.startsWith('author ')) {
        author = l.replace(/^author /, '');
        continue;
      }
      if (l.startsWith('summary ')) {
        subject = l.replace(/^summary /, '');
        continue;
      }
      if (l.startsWith('\t')) {
        // 代码行输出，组装一条记录
        // 注意：不要清空 hash/author/subject —— porcelain 格式中同一提交的多行
        // 只输出一次元数据，后续行需沿用上一次的 author/subject
        result.push({
          lineNumber: lineNum,
          shortHash: hash.substring(0, 7),
          fullHash: hash,
          author,
          subject
        });
      }
    }
    return result;
  } catch (e) {
    return [];
  }
}
