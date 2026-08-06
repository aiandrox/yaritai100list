# やりたいことリスト100 — 現行仕様の棚卸し

既存実装（`yaritaikoto100_be` / `yaritaikoto100_fe2`）から読み取った仕様。作り直しの出発点として、
**「実装されている仕様」** と **「未実装・破綻している箇所」** を分けて記録する。

- 現行デプロイ: フロント = `https://yaritaikoto100.vercel.app`（`yaritaikoto100_fe2` = `aiandrox/yaritaikoto100` の main）
- BE はどこにもデプロイされていない。フロントは `https://localhost:3000` を叩いており、本番は localStorage のみで動作している。
- `yaritaikoto100_fe` は 2024-01-02 に始めた Next.js → CRA 移植の中断物。リモートなし・デプロイ対象外。

---

## 1. プロダクト概要

100個の枠に「やりたいこと」を書き、達成したら完了印を付けるリストアプリ。

- 未ログインでもそのまま使える（ブラウザの localStorage に保存）
- Google ログインするとサーバーに保存され、ログイン時に localStorage の内容を引き継いでリストを作成する
- リストは `uuid` と `published`（公開フラグ）を持つ = 他人に共有して見せる構想があった

---

## 2. ドメインモデル

MySQL 8.0。`db/schema.rb` version `2023_08_11_142532`。

### users
| カラム | 型 | 制約 |
|---|---|---|
| `uid` | string | NOT NULL, UNIQUE — Google の uid |
| `name` | string | NOT NULL |
| `email` | string | NOT NULL, UNIQUE |
| `access_token` | string | nullable — 発行中の JWT を保持 |

### lists
| カラム | 型 | 制約 |
|---|---|---|
| `user_id` | bigint | NOT NULL, FK → users |
| `uuid` | string | NOT NULL, UNIQUE — `SecureRandom.urlsafe_base64`。外部公開用ID |
| `title` | string | NOT NULL, 最大15文字。既定値 `やりたいことリスト` |
| `published` | boolean | NOT NULL, default `true` |

### items
| カラム | 型 | 制約 |
|---|---|---|
| `list_id` | bigint | NOT NULL, FK → lists |
| `number` | integer | NOT NULL — リスト内の番号（1〜100想定） |
| `name` | string | NOT NULL |
| `done_at` | datetime | nullable — 完了日時。boolean ではない |

`user has_many :lists (dependent: :destroy)` / `list has_many :items (dependent: :destroy)`

### 確定しているルール
- **「現在のリスト」= `user.lists.order(updated_at: :desc).first`**。1ユーザー複数リストを許す構造。
- **items は疎に持つ**。空文字の項目はレコードを作らず、番号が飛ぶ。`spec/models/list_spec.rb` が
  `['北海道旅行に行く', '', '', '沖縄旅行に行く']` → 2件・番号 `1` と `4` になることを明示している。
- 100という個数は**フロント側の都合**（`Array.from({ length: 100 })`）でしかなく、BE に制約はない。
- 文字数: リストタイトル 15文字（BEバリデーション）、項目名 22文字（FE の `maxLength` のみ、BE 制約なし）。

---

## 3. GraphQL API

エンドポイント `POST /graphql/enterprise`（開発時のみ GraphiQL を `/graphiql/enterprise` にマウント）。
`graphql-ruby` + `graphql-batch`（`AssociationLoader` で N+1 回避）、`max_depth 20`。

### Query
| フィールド | 戻り | 内容 |
|---|---|---|
| `currentList` | `ListType!` | `current_user.lists.order(updated_at: :desc).first` |
| `currentUser` | `UserType`（null可） | `context[:current_user]` |

### Mutation（すべて Relay Classic 形式 = `input:` でラップ）
| 名前 | 引数 | 戻り |
|---|---|---|
| `createList` | `items: [String!]!` | `list` — `List.create_default_value!` でタイトル既定・空要素スキップ |
| `updateList` | `uuid: String!`, `published: Boolean!` | `list` — 公開状態の切り替えのみ |
| `upsertItem` | `listUuid: String!`, `number: Int!`, `name: String`, `doneAt: ISO8601DateTime` | `item` — `find_or_initialize_by(number:)` |

### 型
- `UserType`: `id: Int!`, `name: String!`（email は公開していない）
- `ListType`: `user: UserType!`, `uuid: String!`, `title: String!`, `published: Boolean!`, `items: [ItemType]!`
- `ItemType`: `list: ListType!`, `number: Int!`, `name: String!`, `doneAt: ISO8601DateTime`

### 横断的な挙動
- `BaseResolver` / `BaseMutation` の `ready?` で `authenticate_user!` → 未ログインは `UnauthenticatedError`（message `"unauthencated"`、typo）。
- `ActiveRecord::RecordNotFound` を `NotFoundError`（`"List not found"` 等）に変換。
- 他人のリストを指定した `upsertItem` は `List not found` になる（`spec/.../upsert_item_spec.rb` で担保）。
- `Resolvers::Enterprise::List`（`uuid` 引数で1件取得）は実装されているが **QueryType に接続されていない**。

---

## 4. 認証・セッション

```
FE フッター「Googleログイン」
  → GET  {BE}/auth/google_oauth2          (omniauth-google-oauth2, GET のみ許可)
  → Google 認証
  → GET  {BE}/auth/google_oauth2/callback → SessionsController#create
        - User.find_or_create_from_auth_hash(uid で検索、無ければ email/name で作成)
        - JWT を発行して users.access_token に保存
        - Set-Cookie: access_token
  → 302 {FE}/callbacks
FE /callbacks
  → localStorage の items を読んで createList
  → / へリダイレクト
```

- **JWT**: `{ sub: user.id, exp: 1週間後の end_of_day, iat: now }`、鍵は `ENV['ACCESS_TOKEN_SECRET_KEY']`。
- **Cookie**: `access_token` / `HttpOnly` / `Secure` / `SameSite=None` / `Path=/` / `expires` は JWT の exp と同じ。
  クロスサイト（Vercel ↔ Rails）前提のため `SameSite=None` + `Secure` が必須で、ローカルも https で動かしていた
  （`localhost.pem` / `localhost-key.pem` が BE リポジトリに同梱、`codegen.ts` は `NODE_TLS_REJECT_UNAUTHORIZED=0`）。
- **検証**: Cookie の JWT を decode し `User.find_by!(id: payload['sub'], access_token:)`。
  DB の値と一致必須なので、**サーバー側から失効させられる／同時に1セッションのみ**という設計。
- **リダイレクト先**: `YaritaikotoUrl` が production なら `https://yaritaikoto100.vercel.app`、それ以外は `http://localhost:9000`（ハードコード）。
- **CORS**（rack-cors, `credentials: true`）: dev `localhost:9000` / production `https://yaritaikoto100.vercel.app/`。
- **ヘルスチェック**: `GET /health_check` → 200。

### ポート構成（開発）
| | ポート |
|---|---|
| BE (Rails, https) | 3000 |
| FE (Next.js) | 9000（`next dev -p 9000`。未コミット変更で 8000 に変えられている） |
| MySQL (docker-compose) | 3306 |

---

## 5. 画面仕様

実質1画面 + コールバック。Tailwind、モバイル前提の縦1カラム。

### 共通レイアウト
- 背景色 `#ffa2ab`（ピンク）、`max-w-[500px]` 中央寄せ、`min-h-screen`
- タイトルは白の `text-3xl font-bold`、右端にアイコン1つ
- 画面下端に固定フッター（白地・上ボーダー）

### `/` トップ
`currentUser && currentList` が揃えばサーバー版、それ以外は localStorage 版を表示する分岐。

| | サーバー版 (`ListComponent`) | localStorage 版 (`LocalStorageListComponent`) |
|---|---|---|
| 見出し | `list.title` | `やりたいことリスト` 固定 |
| 右アイコン | 歯車（`text-gray-200`） | ダウンロード（`text-gray-600`） |
| 編集 | **不可**（`onChangeName` を渡していない） | 可。入力ごとに localStorage `items` に「名前だけの配列」を JSON で保存 |

いずれも 1〜100 の行を必ず100行描画する（データが無い番号は空欄）。

### 行 (`RowComponent`)
- 左: 3桁ゼロ埋めの番号（`001`）。`doneAt` があれば赤いチェックアイコンを重ねる
- 中央: テキスト入力（`maxLength={22}`、白背景・角丸）
- 右: `name` が入っていればハンバーガーアイコン。クリックで小さなメニューを開き **「完了」「削除」** を表示するが、
  **どちらもクリックハンドラが無く動作しない**

### フッター
| リンク | 現状 |
|---|---|
| マイリスト | `href="#"` — 未実装 |
| Googleログイン | `https://localhost:3000/auth/google_oauth2` にハードコード |
| ログアウト | `onClick={() => "https://localhost:3000/logout"}` — 文字列を返すだけで何も起きない |

### `/callbacks`
localStorage の items を読んで `createList` を呼び、`/` にリダイレクトする想定。
現状は `handleCreateList(["test", "test2"])` の固定値のまま。`"use client"` なのに `redirect()` を使い、
拡張子が `.ts` のため JSX も返せない、成立していないファイル。

---

## 6. 現行技術スタック

| | |
|---|---|
| BE | Ruby 3.2.2 / Rails 7.0.7（`ActionController::API`）/ MySQL 8.0.32 / graphql-ruby / graphql-batch / omniauth-google-oauth2 / JWT / RSpec + FactoryBot / RuboCop / annotate |
| FE | Next.js 13.4.12（app router）/ React 18 / Apollo Client 3.8 / Tailwind 3.3 / graphql-codegen（`near-operation-file` preset、スキーマは起動中の BE から取得） |

Apollo の設定で特徴的な点:
- 全オペレーションが `fetchPolicy: "no-cache"`
- `credentials: "include"`、`X-Requested-With: XMLHttpRequest` を常時付与
- リクエストURLに `?opname=<OperationName>` を付ける独自 fetch ラッパー（ログ・監視向け）

---

## 7. 未実装 / 破綻している箇所

作り直しの際にそのまま持ち込まないよう明記する。

### バグ・動かないもの
1. **ログアウトが動かない**。`SessionsController#destroy` が `user.reset_access_token!` を呼ぶが、
   `User` に定義されていない（`update_access_token!` しかない）。最後のコミット `logout wip` はここで止まっている。
2. **`currentList` が `null: false`** なのに、リスト0件のユーザーでは `nil` を返す → GraphQL エラーになる。
3. **`currentUser` も認証必須**（`BaseResolver#ready?`）なので、未ログイン判定には使えない。
   FE は `currentUser && currentList` で分岐しているため、エラーが出ても静かに localStorage 表示に落ちる。
4. **ログイン時は項目を編集できない**（`ListComponent` が `onChangeName` を渡していない）。
   `upsertItem` mutation は存在するが FE から一度も呼ばれていない。
5. **項目の「完了」「削除」が未実装**。削除用の mutation 自体が存在しない（`done_at` は upsert で表現可能）。
6. **`Resolvers::Enterprise::List` が壊れている**。`uuid` を引数に取りながら `lists.find(id)` と未定義の `id` を参照。
7. **CORS の production origin が `'https://yaritaikoto100.vercel.app/'`**（末尾スラッシュ付き）でマッチしない。
8. **`BE_URL` は `NEXT_PUBLIC_` 接頭辞がない**ため、ブラウザ側バンドルでは常に `undefined`。
   現行 main はそれを避けて `https://localhost:3000` をハードコードしている。
9. `items` に `(list_id, number)` の複合ユニークインデックスが無く、同一番号の重複を防げていない。
10. git 履歴に `GOOGLE_CLIENT_SECRET` / `NEXTAUTH_SECRET` が残っている（`735eed0` で削除済みだが履歴から辿れる）。
    鍵が生きているならローテートが必要。

### 仕様として決まっていないもの
11. **localStorage → サーバーの引き継ぎ**が「ログインするたび `createList`」なので、ログインごとにリストが増える。
    既存リストがある場合にどうするか（マージ／上書き／作らない）が未定義。
12. **1ユーザー複数リストにするのか**。DB は複数前提、`currentList` は「最後に更新した1件」、
    フッターに「マイリスト」の枠だけある、という中途半端な状態。
13. **共有機能**。`uuid` と `published` はあるが、公開閲覧用のページ・クエリが無い。`updateList` で
    フラグだけ切り替えられる。読み取り専用の公開ページを作るかどうか。
14. **リストタイトルの変更UI が無い**（15文字制約だけ存在）。
15. **項目は100固定なのか**。FE のループが唯一の根拠。BE に個数の制約はない。
16. **BE のデプロイ先が未決定**（MySQL 必須、Cookie の `SameSite=None; Secure` 前提で https 必須）。
    FE と別ドメインを維持するのか、同一ドメインに寄せるかで認証方式の選択が変わる。
17. `enterprise` という名前空間（`/graphql/enterprise`、`Types::Enterprise::*`、`EnterpriseSchema`）に
    意味は無く、テンプレート由来。作り直すなら整理対象。
18. `email` は保存しているが GraphQL で公開していない。ユーザー情報の露出範囲を決める。

---

## 8. 環境変数

| 変数 | 場所 | 用途 |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | BE | omniauth |
| `ACCESS_TOKEN_SECRET_KEY` | BE | JWT 署名鍵 |
| `BE_URL` | FE | GraphQL エンドポイント。要 `NEXT_PUBLIC_` 化 |

FE 側の `.env` は `BE_URL=http://localhost:9000` になっているが、9000 は FE 自身のポートで**値が誤っている**。
BE は 3000。
