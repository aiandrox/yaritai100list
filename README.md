# やりたいことリスト100 (`yaritai100list`)

100個のやりたいことを書き溜めて、叶えたら印を付けるアプリ。

ログインせずに使え（ブラウザに保存）、ログインすると永続保存と複数のマイリストが使える。
将来的にリストの共有、SNS カード（OGP）、画像出力、他人のやりたいことの取り入れに対応する。

**現在の状態: 土台を構築中。**
`apps/web` が Hono + D1 + Drizzle で動くところまで来ている。
進捗は[イシュー](https://github.com/aiandrox/yaritai100list/issues)を参照。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) | プロダクト仕様。何を作るか |
| [TECH_STACK.md](./TECH_STACK.md) | 技術構成。なぜその選択をしたか、各案のメリット・リスク |
| [MEMO.md](./MEMO.md) | 申し送り。実装順序を決めた理由、命名の検討過程 |
| [docs/workflow.md](./docs/workflow.md) | **開発の進め方。** イシューの進め方、PR の流れ、完了の条件 |
| [docs/console-settings.md](./docs/console-settings.md) | **コンソールでしか設定できない項目**と現在値 |

読む順番は `PRODUCT_SPEC.md` → `TECH_STACK.md`。
作業に入るときは `docs/workflow.md`。

## 進め方

作業単位は GitHub の[イシュー](https://github.com/aiandrox/yaritai100list/issues)で管理する。
親イシュー #1〜#10 が機能単位で、`MVP`（#1〜#6）と `Post-MVP`（#7〜#10）の2マイルストーンに分かれる。
着手時に 1 PR 単位のサブイシューへ分割する。詳細は [docs/workflow.md](./docs/workflow.md)。

## ローカル開発

Cloudflare のアカウントもログインも不要。すべてローカルで動く。

```sh
npm install
npm run db:migrate --workspace @yaritai100list/web   # ローカル D1 にマイグレーションを当てる
npm run dev                                          # http://localhost:5173

npm run typecheck && npm run lint && npm test        # PR を出す前に緑にする
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | Vite。**SPA と Worker の両方**が1プロセスで動く（Worker は workerd で実行される） |
| `npm test` | Vitest + Miniflare。workerd の中で走り、D1 はインメモリ |
| `npm run build --workspace @yaritai100list/web` | `dist/client`（SPA）と `dist/yaritai100list`（Worker）を出す |
| `npm run db:generate --workspace @yaritai100list/web -- --name <名前>` | スキーマからマイグレーションを生成（**名前は必ず付ける**） |
| `npm run db:migrate --workspace @yaritai100list/web` | ローカル D1 に適用 |

**Vite の dev サーバーは IPv6（`[::1]`）でだけ listen する。**
`curl http://127.0.0.1:5173` は接続できないので `localhost` を使う。

環境変数は `apps/web/.dev.vars.example` を `.dev.vars` にコピーして使う。
**通常のローカル開発では何も入れなくても動く**（`SENTRY_DSN` が空ならエラー通知は無効）。

**`no such table` が出たら `db:migrate` を忘れている。**
ローカル D1 の保存先は `wrangler.jsonc` の `database_id` ごとに分かれるため、
その値を変えると**空のデータベースに切り替わる**（`.wrangler/state/` 配下）。
テストは別のインメモリ D1 を使うので、テストが緑でもこの状態は起こりうる。

## 構成

```
apps/
  web/        Cloudflare Workers（Hono + React SPA + D1）
  render/     Deno Deploy（Satori による画像生成）  ← 未作成
packages/
  shared/     型・Zod スキーマ・定数
```

`apps/render` は OGP 画像に着手する時点で作る
（Deno なので、npm workspaces に含めるかは `TECH_STACK.md` §12-2 の結論次第）。
**ディレクトリ名は Deno Deploy のアプリ名 `yaritai100list-render` に合わせている**
（`docs/console-settings.md`）。`image` にしないのは、PNG 以外の出力が来たときに名前がズレるため。

デプロイ先は2つだが、**リポジトリは1つ**にする。
分けると、どのリポジトリが生きているのかを追えなくなる。

## 技術構成の要点

- Cloudflare Workers + D1 + Hono + React（SPA）+ Drizzle + Zod
- 認証は Better Auth（セッションは D1 のみ。KV の `secondaryStorage` は使わない）
- 画像生成のみ Deno Deploy（Satori + `@resvg/resvg-wasm`）
- カスタムドメインは使わず `*.workers.dev`
- **月額 ¥0**（行き詰まったら Cloudflare Workers Paid の $5 に寄せる）

詳細と選定理由は [TECH_STACK.md](./TECH_STACK.md) を参照。
