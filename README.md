# やりたいことリスト100 (`yaritai100list`)

100個のやりたいことを書き溜めて、叶えたら印を付けるアプリ。

ログインせずに使え（ブラウザに保存）、ログインするとサーバーに保存され、
リストを複数持てて、人に共有できる。

**https://yaritai100list.aiandrox.workers.dev**

**進捗と作業中の内容は[イシュー](https://github.com/aiandrox/yaritai100list/issues)にある。**
このファイルには**変わらないことだけ**を書く。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) | プロダクト仕様。**何を作るか**と、決めた理由 |
| [TECH_STACK.md](./TECH_STACK.md) | 技術構成。**いまの構成と守るべき方針**、踏んだ落とし穴 |
| [docs/workflow.md](./docs/workflow.md) | **開発の進め方。** イシューの進め方、PR の流れ、完了の条件 |
| [docs/console-settings.md](./docs/console-settings.md) | **コンソールでしか設定できない項目**と現在値 |
| [CLAUDE.md](./CLAUDE.md) | AI 向けの入口。**不変条件**（破ってはいけない約束）はここ |

**手を動かす前に `docs/workflow.md`。** そのあと `PRODUCT_SPEC.md` → `TECH_STACK.md`。

⚠️ **実装の判断はイシューに残している。** 「なぜそう決めたか」はドキュメントではなく
`gh issue view <N> --comments` を見る。

## ローカル開発

Cloudflare のアカウントもログインも不要。**すべてローカルで動く。**

```sh
npm install
npm run db:migrate --workspace @yaritai100list/web   # ローカル D1 にマイグレーションを当てる
npm run dev                                          # http://localhost:5173

npm run typecheck && npm run lint && npm test        # PR を出す前に緑にする
```

- `npm run dev` は **SPA と Worker の両方**が1プロセスで動く（Worker は workerd で実行される）
- `npm test` は workerd の中で走り、D1 はインメモリ
- **`apps/render` は Deno。** `cd apps/render && deno task test`（`deno` が要る）
- 環境変数は `apps/web/.dev.vars.example` を `.dev.vars` にコピー。
  **通常は何も入れなくても動く**
- 詰まったときは `docs/workflow.md` の「ローカルで詰まったとき」

## 構成

```
apps/
  web/        Cloudflare Workers（Hono + React SPA + D1）
  render/     Deno Deploy（Satori による画像生成）
packages/
  shared/     型・Zod スキーマ・定数（サーバー・クライアント・画像生成の3箇所から使う）
```

**デプロイ先は2つになるが、リポジトリは1つ。**
分けると、どのリポジトリが生きているのかを追えなくなる。

`main` にマージすると**自動でデプロイされる**（`.github/workflows/deploy.yml`）。
