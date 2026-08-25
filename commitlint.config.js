module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-case': [2, 'always', 'lowerCase'],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [0, 'never'],
    'scope-empty': [0, 'always'],
  },
  prompt: {
    messages: {
      type: '请选择提交类型：',
      scope: '请填写影响范围(可选，例如：core、ui、plugin)：',
      customScope: '自定义范围：',
      subject: '简短描述本次变更(必填，不超过100字符)：',
      body: '详细描述(可选，换行使用 | )：',
      breaking: '是否存在破坏性变更？(y/N)',
      breakingSubject: '破坏性变更说明：',
      footerPrefixsSelect: '选择关联issue类型：',
      customFooterPrefixs: '自定义issue前缀：',
      footer: '填写关联issue编号，例如 #123：',
      confirmCommit: '确认提交以上内容？'
    },
    types: [
      { value: 'feat', name: 'feat:     ✨ 新增功能' },
      { value: 'fix', name: 'fix:      🐛 修复bug' },
      { value: 'docs', name: 'docs:     📝 文档更新' },
      { value: 'style', name: 'style:    💄 代码格式调整，不改变逻辑' },
      { value: 'refactor', name: 'refactor: ♻️ 代码重构，既不新增功能也不修复bug' },
      { value: 'perf', name: 'perf:     ⚡ 性能优化' },
      { value: 'test', name: 'test:     ✅ 新增/修改测试用例' },
      { value: 'build', name: 'build:    🔨 构建流程、外部依赖变更' },
      { value: 'ci', name: 'ci:       🎡 CI配置文件、脚本改动' },
      { value: 'chore', name: 'chore:    🧹 其他不修改src的杂项改动' },
      { value: 'revert', name: 'revert:   ⏪ 回滚某次提交' }
    ],
    useEmoji: true, //开启emoji表情
    emojiAlign: 'left',
    themeCode: false,
    allowCustomIssuePrefixs: true,
    allowEmptyIssuePrefixs: true,
    maxSubjectLength: 100,
    minSubjectLength: 0,
    scopeOverrides: null,
    defaultScope: '',
    skipQuestions: ['footerPrefixsSelect', 'footer'], //跳过issue输入，不需要可以注释
  }
};