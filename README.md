# やりたいことリスト100 (`yaritai100list`)

100個のやりたいことを書き溜めて、叶えたら印を付けるアプリ。

ログインせずに使え（ブラウザに保存）、ログインすると永続保存と複数のマイリストが使える。
将来的にリストの共有、SNS カード（OGP）、画像出力、他人のやりたいことの取り入れに対応する。

**現在の状態: 仕様と技術構成は確定。実装は未着手。**

## ドキュメント

| ファイル | 内容 |
|---|---|
| [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) | プロダクト仕様。何を作るか |
| [TECH_STACK.md](./TECH_STACK.md) | 技術構成。なぜその選択をしたか、各案のメリット・リスク |
| [MEMO.md](./MEMO.md) | 申し送り。旧環境の後始末、着手前の準備、実装の進め方 |
| [docs/legacy-spec.md](./docs/legacy-spec.md) | **旧実装**の棚卸し。作り直し前に何が動いていて何が壊れていたか |

読む順番は `PRODUCT_SPEC.md` → `TECH_STACK.md`。

## 構成（予定）

```
apps/
  web/        Cloudflare Workers（Hono + React SPA + D1）
  image/      Deno Deploy（Satori による画像生成）
packages/
  shared/     型・Zod スキーマ・定数
```

デプロイ先は2つだが、**リポジトリは1つ**にする。
旧実装はリポジトリが3つに分かれていて、どれが生きているか分からなくなっていた。

## 技術構成の要点

- Cloudflare Workers + D1 + Hono + React（SPA）+ Drizzle + Zod
- 認証は Better Auth（セッションは D1 のみ。KV の `secondaryStorage` は使わない）
- 画像生成のみ Deno Deploy（Satori + `@resvg/resvg-wasm`）
- カスタムドメインは使わず `*.workers.dev`
- **月額 ¥0**（行き詰まったら Cloudflare Workers Paid の $5 に寄せる）

詳細と選定理由は [TECH_STACK.md](./TECH_STACK.md) を参照。
