// ====================== 共享类型定义 ======================

// 代码行数统计结果
export interface CountResult {
  fileCount: number;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

// 历史快照条目（在 CountResult 基础上追加时间/路径）
export interface HistoryItem extends CountResult {
  timestamp: number;
  humanTime: string;
  targetPath: string;
}

// 扩展全局存储结构
export interface ExtensionGlobalState {
  historyList: HistoryItem[];
}

// git单条提交信息（行尾blame用）
export interface GitLineCommitInfo {
  lineNumber: number;
  shortHash: string;
  author: string;
  subject: string;
  fullHash: string;
}

// 文件的某次git提交记录及其对应行数统计
export interface GitCommitStat {
  hash: string;
  shortHash: string;
  author: string;
  dateLabel: string;
  dateTs: number;
  subject: string;
  stats: CountResult;
  isWorkingTree: boolean; // 是否为"当前工作区"合成记录
}
