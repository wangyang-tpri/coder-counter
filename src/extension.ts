import * as vscode from 'vscode';
import { DIFF_SCHEME, GitRevisionContentProvider } from './git.js';
import { registerBlameFeature } from './blame.js';
import { registerCommands } from './commands.js';

export function activate(context: vscode.ExtensionContext) {
  registerBlameFeature(context);
  registerCommands(context);
  // 注册自定义文本内容提供器，使vscode.diff能读取提交历史版本文件
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitRevisionContentProvider())
  );
}

export function deactivate() {}
