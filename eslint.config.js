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
      // wrangler types の生成物。lint する対象ではない
      '**/worker-configuration.d.ts',
      // 🔴 **画像生成サービスは Deno。** npm の tsconfig の対象外なので、
      // ここで見ようとすると「project service に無い」で落ちる。
      // 型と lint は Deno 側の道具で見る（`deno check` / `deno lint`。CI にも入れてある）。
      // **書式だけは prettier に任せる**（リポジトリで1つにする）
      'apps/render/**',
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
