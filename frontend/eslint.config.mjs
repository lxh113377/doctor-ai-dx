// 前端/Functions/测试脚本静态检查唯一权威配置（ESLint 9 flat config）。
// 判据设计（2026-09-25，对标第十四轮）：
//   1. 覆盖面 = 全部生产面与门禁面（functions/ + src/ + tests/ + 根配置），不留"没配所以不查"的死角；
//   2. 刻意不做风格刑（不接 prettier/尺寸规则）——本仓双端镜像靠 contract_parity 逐字段核对，
//      格式规则只会制造无意义 churn，而未定义变量/隐式全局/依赖数组缺项/失效 hook 是真缺陷来源；
//   3. 生成物 semantic_neighbors.js 不豁免：它由 scripts/build_semantic_neighbors.py 重生，
//      若生成器写出非法语法，这里必须判红（另有 semantic_guard 按语料指纹核对内容）。
import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'node_modules/**', '.wrangler/**', 'coverage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 未使用变量：下划线前缀显式声明"刻意不用"（回调占位参数），其余一律判红
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      // 刻意不开 require-await：本仓有两类合法"无 await 的 async"——
      //   ① tests/live_path_guard.mjs 的 fetch 桩必须返回 Promise 才与真 fetch 同形；
      //   ② functions/lib/engine.js reuseOrBuild 保持 async 签名与 buildDiagnosis 一致。
      // 该规则在这两处都不指向真缺陷，开它只会逼人把桩改成同步 ⇒ 测的不是真实调用路径。
    },
  },

  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      // ESLint 核心的 no-unused-vars 不计 JSX 引用（实测：渲染中的 ModeBadge 被误报未使用）。
      // 缺这两条 ⇒ 任何组件被"用到"仍会判红，逼人删掉在用 import ⇒ 白屏。故必须显式接线。
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },
]
