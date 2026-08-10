/* ESLint 設定（JavaScript / JSX，不使用 TypeScript） */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: 'detect' } },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    'react/prop-types': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // 測試檔與測試工具（第 14 章）。
      // 兩個調整：
      // 1. env.node + globals：describe / it / expect / vi 是 Vitest 注入的全域變數
      //    （vite.config.js 設了 globals: true），不宣告的話 no-undef 會全部報錯。
      // 2. 關掉 react-refresh：測試工具檔會同時匯出元件與一般函式，
      //    這在正式程式碼是壞味道，但在測試 helper 是正常寫法。
      files: ['src/**/*.test.{js,jsx}', 'src/test/**/*.{js,jsx}'],
      env: { node: true },
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
      rules: {
        'react-refresh/only-export-components': 'off',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules'],
}
