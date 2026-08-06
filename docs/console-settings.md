# コンソール設定の記録

**各サービスの管理画面でしか設定できない項目と、その現在値を残す。**

理由は `TECH_STACK.md` §1 / §10 に書いた通り。コンソールでクリックして設定した項目が原因の不具合は、
コードをいくら読んでも原因に到達できない。「ログインできない」の原因が承認済みドメインの設定漏れだった場合、
コードのどこにも手がかりがない。

**秘密の値（クライアントシークレット、API キー、HMAC 鍵、DSN）はここに書かない。**
「どこに設定したか」と「どの名前で参照しているか」だけを書く。

設定を変えたらこのファイルを更新する（`docs/workflow.md` §6）。

---

## GitHub

| 項目 | 現在値 | 備考 |
|---|---|---|
| リポジトリの可視性 | **public** | ブランチ保護と Actions 無制限のため。経緯は下記 |
| Issues | 有効 | |
| Actions の無料枠 | **無制限**（public） | private だと月2,000分だった |
| ルールセット（`main`） | **設定済み**。PR 必須 / CI 必須 / force push 禁止 | 詳細は下記。bypass は設けていない |
| Dependabot | `.github/dependabot.yml` で管理 | コード側なのでコンソール作業は不要 |

### `main` のルールセット

`docs/workflow.md` の「`main` に直接コミットしない」「CI が緑になってからマージする」を、
規律ではなく仕組みで守るために設定した。

ルールセット名 `protect main`（id `20485718`）。対象は `~DEFAULT_BRANCH`。

| ルール | 値 |
|---|---|
| Pull request を必須にする | 有効。**必要な承認数は 0**（レビューする人間がいないため） |
| マージ方法 | **squash のみ**（`docs/workflow.md` §5 に合わせた） |
| ステータスチェックを必須にする | `check`（`.github/workflows/ci.yml` のジョブ名） |
| ↑ strict ポリシー | **有効。** 最新の `main` に追随していない PR はマージできない |
| force push を禁止する | 有効（`non_fast_forward`） |
| `main` の削除を禁止する | 有効（`deletion`） |
| bypass できるアクター | **なし。** 管理者も抜け道を持たない |

**strict を有効にした影響**: 自分の PR を出している間に `main` が進むと、
そのままではマージできない。`gh pr update-branch` で追随させてから CI を待つ。
これは「緑だった PR が、古い `main` を前提にしていたために `main` を壊す」事故を防ぐため。

設定内容を変えるコマンド（bypass がないため、ルールセット自体の編集はこの経路で行う）:

```sh
gh api repos/aiandrox/yaritai100list/rulesets/20485718        # 現在値を見る
gh api -X PUT repos/aiandrox/yaritai100list/rulesets/20485718 --input <file>
```

**動作確認済み**: `main` への直接 push は `GH013` で拒否される
（`Changes must be made through a pull request` / `Required status check "check" is expected`）。

**bypass を設けていないのは意図的。** 抜け道があると、赤い CI をすり抜けてマージできてしまい、
「CI が唯一のゲート」という前提が崩れる。人間がレビューしない開発ではここを緩めない。

副作用として、**ドキュメントのみの変更を `main` に直接コミットすることもできなくなった。**
`docs/workflow.md` §5 の例外はこれに合わせて削除した。

### 経緯: private では設定できなかった

当初 private だったため、ブランチ保護もルールセットも使えなかった
（`gh api .../branches/main/protection` が 403 を返す。GitHub Free の制約）。
選択肢は「public にする」「GitHub Pro に上げる（$4/月）」「運用で守る」の3つで、
リポジトリにシークレットを置かない方針（`TECH_STACK.md` §9）のため public を選んだ。

**public にしたので、コミットする内容は誰でも読める。**
シークレットを絶対に入れないという方針の重要性が上がった。

---

## Cloudflare

**設定済み**（#1、2026-08-06）。

| 項目 | 現在値 | 備考 |
|---|---|---|
| アカウント | `aiandrox7@gmail.com` | |
| Account ID | `89a295a0c7739f64b3bc773f09904aeb` | 秘密の値ではない |
| プラン | **Free** | 有料化は `TECH_STACK.md` §7 の判断が要る |
| Workers のサブドメイン | **`aiandrox`** | ホスト名は `yaritai100list.aiandrox.workers.dev` |
| カスタムドメイン | **使わない**（決定事項） | WAF とレート制限が使えない点は `TECH_STACK.md` §8 |

### D1

| 項目 | 現在値 | 備考 |
|---|---|---|
| データベース名 | `yaritai100list` | |
| `database_id` | `78718e38-9558-416b-b7c2-61b6a00be62d` | `wrangler.jsonc` にも書くのでコード側にも残る |
| リージョン | **`APAC`** | `wrangler d1 create` が自動選択した |
| バインディング名 | **`DB`** | `wrangler.jsonc` で指定。`wrangler d1 create` の出力例は `yaritai100list` になっているが採用しない |

### コンソールでしか触れないもの

- **`workers.dev` のサブドメイン名。** Cloudflare 全体でグローバルに一意。
  変更すると旧サブドメインが解放されて他人に取られうる。
  **共有リンクが死ぬので変更しない**（`PRODUCT_SPEC.md` の共有機能の前提）
- アカウントのプラン変更（Free → Paid）

### コンソールで触らないもの（コード側で管理する）

- Worker のデプロイ、ルート、環境変数、バインディング → すべて `wrangler.jsonc`
- **ダッシュボードから Worker を作らない。** `wrangler deploy` で作る。
  ダッシュボードのウィザード（"Ship something new"）から作ると設定がコードから外れる

---

## Google Cloud（OAuth）

**設定済み**（#1、2026-08-06）。旧実装のクレデンシャルは流用していない。

**OAuth クライアントを development / production で分けている。**
GCP プロジェクトは1つ（同意画面はプロジェクト単位で共有されるため、分けると設定漏れの面が増える）。

| | production | development |
|---|---|---|
| Client ID | `360816377904-1h28d71uu6q42a1ggi1j8hdjquerhr34.apps.googleusercontent.com` | `360816377904-5jhsstvqt3313uvnv5g6n7k0vu2m8t2b.apps.googleusercontent.com` |
| 種類 | ウェブアプリケーション | ウェブアプリケーション |
| 承認済みリダイレクト URI | `https://yaritai100list.aiandrox.workers.dev/api/auth/callback/google` | `http://localhost:8787/api/auth/callback/google` |
| 承認済みの JavaScript 生成元 | **空** | **空** |
| Client Secret の置き場所 | Workers のシークレット | `.dev.vars` |

同意画面は **外部 / 公開**。

### 分けている理由

1. **本番のシークレットがローカルの `.dev.vars` に降りてこない。**
   このリポジトリは public で、AI がファイルを日常的に触る。事故の被害が開発側に閉じる
2. **本番クライアントの許可リストに `http://localhost` を残さずに済む。** localhost は誰でも立てられる
3. **ローテートが片側だけで済む。** 開発側の鍵が漏れても本番のログインを止めずに差し替えられる

### ⚠️ ここが原因の不具合が一番多い

- **`redirect_uri_mismatch` が出たら、まず承認済みリダイレクト URI を疑う。**
  末尾スラッシュの有無、`http` / `https`、ポート番号まで完全一致が必要
- `8787` は `wrangler dev` のデフォルトポート。**別のポートで起動すると development 側が一致しなくなる**
- **承認済みの JavaScript 生成元を空にしているのは意図的。**
  Better Auth はサーバー側の認可コードフローを使う。`JavaScript 生成元` が必要なのは、
  ブラウザから直接トークンエンドポイントを叩く GIS / implicit フローだけ。空のままの方が攻撃面が狭い。
  **「ログインできない」の調査でここを埋めようとしないこと。原因は別にある**
- **`GOOGLE_CLIENT_ID` も環境によって値が変わる。**
  「Client ID は公開値だから」と `wrangler.jsonc` に1つ直書きすると、ローカルで本番クライアントを使ってしまう

### 旧クレデンシャル

旧リポジトリの git 履歴に `GOOGLE_CLIENT_SECRET` / `NEXTAUTH_SECRET` が残っていたため、
**旧 GCP プロジェクトごと削除した（2026-08-06）。**

GCP のプロジェクト削除には **30日の削除保留期間**がある。保留中はリソースが停止するので
OAuth クライアントは削除の瞬間から使えないが、完全消滅は **2026-09-05 頃**。

---

## Deno Deploy（画像生成）

**organization まで作成済み**（#1、2026-08-06）。アプリの作成は #8 で行う。

| 項目 | 現在値 | 備考 |
|---|---|---|
| コンソール | https://console.deno.com | Classic（`dash.deno.com`）は 2026-07-20 廃止 |
| organization slug | **`aiandrox`** | |
| プラン | **Free** | **クレジットカード登録は不要**（2026-08-06 にサインアップ画面で確認） |
| アプリ名 | **`yaritai100list-render`**（未作成） | #8 で作る |
| 想定ホスト名 | `yaritai100list-render.aiandrox.deno.net` | |
| HMAC 鍵の名前 | `RENDER_HMAC_SECRET` | Cloudflare 側と同じ値を共有する。値はここに書かない |

### コンソールでしか触れないもの

- **organization slug。** デフォルトドメインが `{app-name}.{org-slug}.deno.net` になる。
  変更すると既存 URL が全部壊れる（TLS 再発行に数分）。
  ただしこの URL は Cloudflare 側の環境変数に入るだけで外部に共有されないため、変更コストは低い
- アプリの環境変数（`RENDER_HMAC_SECRET`）

### ⚠️ Deno Deploy 側に置いてよいものの境界

**`yaritai100list-render` は状態を持たないレンダラである。API・認証・DB を置かない。**

`TECH_STACK.md` §7「なぜ BE を分けないか」のとおり、旧実装は Vercel + Rails の2ドメイン構成だったため
`SameSite=None` の Cookie、自己署名 https、CORS の origin 設定ミスが連鎖して壊れた。
今回はそれを構造的に消すために、**API・認証・DB はすべて Cloudflare Workers 側**に置くと決めている。

Deno Deploy 側が例外として許されているのは、**あれが Cookie も認証も持たない純関数だから**。
「データ → PNG」以外のものをここに置いた瞬間、その理由が成立しなくなる。

守ること（`CLAUDE.md` の不変条件）:

- **渡すデータは、呼び出し側で認可を通した後のものに限る。**
  生成サービス側に「このリストは公開か」を判断させない
- **画像生成エンドポイントは HMAC で署名する。** 誰でも叩ける状態にしない
  （放置すると CPU 枠を溶かす踏み台になる）

**「BE」ではないので、そういう名前も付けない**（`yaritai100list-be` を候補から外した経緯は #1 のコメント）。

---

## Sentry（エラー通知）

**未設定。** #1 のステップ4。

| 項目 | 現在値 | 備考 |
|---|---|---|
| organization | 未作成 | |
| プラン | Developer（無料） | **5,000 errors/月・1ユーザー・保持30日**（2026-08-06 時点） |
| Workers 用プロジェクト | 未作成 | プラットフォームは `Cloudflare Workers`（`@sentry/cloudflare`） |
| Deno 用プロジェクト | 未作成 | プラットフォームは `Deno`（`@sentry/deno`） |
| DSN の置き場所 | 未設定 | 環境変数。値はここに書かない |

### ⚠️ 無料枠の 5,000 errors/月は**プロジェクト間で共有**

プロジェクトを2つに分けても枠は増えない。**エラーループが起きると1日で枠を焼き切って、
以降の障害に気づけなくなる。**「壊れたことを知る手段」が目的なので、ここが潰れると本末転倒。

対策として、**Spike Protection を有効にし、クライアントキーごとのレート制限を設定する**。
設定したらこの表を埋める。

---

## シークレットの置き場所

**値はこのファイルに書かない。** 名前と置き場所だけを記録する。

| 名前 | 用途 | ローカル | 本番（Workers） | 本番（Deno Deploy） |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth（**環境ごとに値が違う**） | `.dev.vars` | `wrangler.jsonc` の `vars` | — |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | `.dev.vars` | `wrangler secret put` | — |
| `BETTER_AUTH_SECRET` | セッション署名 | `.dev.vars` | `wrangler secret put` | — |
| `RENDER_HMAC_SECRET` | 画像生成の署名（**両側で同じ値**） | `.dev.vars` | `wrangler secret put` | コンソールの環境変数 |
| `SENTRY_DSN` | エラー通知 | `.dev.vars` | `wrangler.jsonc` の `vars` | コンソールの環境変数 |

変数名は #3 / #8 / #18 での想定。**確定したらこの表を更新する。**

- **ローカル:** リポジトリ直下の `.dev.vars`。`wrangler dev` が読む。**`.gitignore` に入れる**
- **本番（Workers）:** `npx wrangler secret put <NAME>`。
  **Worker がデプロイされた後でないと実行できない**（シークレットは Worker スクリプトに紐づくため）
- シークレットを受け取ったら、まず**パスワードマネージャに保存する**。
  ダウンロードした JSON は `~/Downloads` から削除する（同期対象になりがちなため）

---

## 旧環境

| 対象 | 状態 |
|---|---|
| 旧 GCP プロジェクト | **削除済み**（2026-08-06。完全消滅は 2026-09-05 頃） |
| `aiandrox/yaritaikoto100` | 未アーカイブ |
| `aiandrox/yaritaikoto100_be` | 未アーカイブ |
| Vercel `yaritaikoto100.vercel.app` | **未判断**（停止 / 新サービスへの案内に差し替え / 放置） |

旧アプリの利用者データは各利用者のブラウザの localStorage にのみ存在し、
ドメインが変わるため**移行不能**（`MEMO.md` §2）。
