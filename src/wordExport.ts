import * as fs from 'fs';
import * as path from 'path';

// ====================== 导出代码为Word（.doc，HTML格式，Word/WPS可直接打开） ======================

const CODE_ALLOW_EXT = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.java', '.c', '.cpp', '.h', '.hpp',
  '.py', '.go', '.rs', '.vue', '.html', '.css', '.scss'
]);
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'out'];

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 收集文件/文件夹下所有白名单代码文件
 * @param rootPath 文件或文件夹绝对路径
 * @returns 文件列表（rel=相对路径，abs=绝对路径，content=文件内容）
 */
export async function collectCodeFiles(rootPath: string): Promise<{ rel: string; abs: string; content: string }[]> {
  const stat = await fs.promises.stat(rootPath);
  const out: { rel: string; abs: string; content: string }[] = [];
  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!CODE_ALLOW_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const content = await fs.promises.readFile(full, 'utf8');
          out.push({ rel: path.relative(rootPath, full).split(path.sep).join('/'), abs: full, content });
        } catch { /* 跳过不可读文件 */ }
      }
    }
  }
  if (stat.isDirectory()) {
    await walk(rootPath);
  } else {
    if (CODE_ALLOW_EXT.has(path.extname(rootPath).toLowerCase())) {
      try {
        out.push({ rel: path.basename(rootPath), abs: rootPath, content: await fs.promises.readFile(rootPath, 'utf8') });
      } catch { /* 跳过不可读文件 */ }
    }
  }
  return out;
}

/**
 * 生成Word可打开的HTML文档内容（.doc）：只把各文件代码按顺序合并导出，无排版
 * @param fsPath 导出目标路径（用于标题）
 * @param files 代码文件列表
 */
export function buildWordHtml(fsPath: string, files: { rel: string; abs: string; content: string }[]): string {
  const title = '代码合并导出 - ' + path.basename(fsPath);
  const sections = files.map(f => `<h2>${escapeHtml(f.rel)}</h2>\n<pre>${escapeHtml(f.content)}</pre>`).join('\n');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
body { font-family: "微软雅黑","Microsoft YaHei",sans-serif; }
h1 { font-size: 14pt; }
h2 { font-size: 12pt; }
pre { font-family: Consolas,"Courier New",monospace; font-size: 10pt; white-space: pre-wrap; word-wrap: break-word; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections}
</body>
</html>`;
}
