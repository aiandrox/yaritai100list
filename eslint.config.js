import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.output/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,

  // 型情報を使うルールを有効にする。`any` は明示的に書いた場合だけでなく、
  // 型のない値から流れ込んだ場合も検出したいため、strictTypeChecked を使う。
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // strictTypeChecked に含まれるが、CLAUDE.md の不変条件なので明示しておく
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // 設定ファイル自体は tsconfig の対象外なので型チェックを外す
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // フォーマットは Prettier に任せる（最後に置いて競合ルールを無効化する）
  prettier,
)
