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
| Actions のシークレット | **`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLAUDE_CODE_OAUTH_TOKEN`** | 前2つは自動デプロイ（#117）。最後は `@claude`（#259）。下記 |
| インストールしている GitHub App | **Claude**（#259） | ブラウザから作業するための経路。下記 |

### Actions のシークレット（自動デプロイ）

`main` にマージすると `.github/workflows/deploy.yml` が本番へ出す（2026-08-07、#117）。
そのために2つのシークレットを登録してある。**値はここに書かない。**

| 名前 | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン（下記の権限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID（秘密ではないが、`wrangler.jsonc` に書かない方針なのでここ） |

登録:

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

⚠️ **リポジトリは public。** Actions のシークレットは
**fork からの PR には渡らない**ため露出しないが、
`deploy.yml` は `push: main` のみで動かしている（PR では動かさない）。

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

## Claude Code（ブラウザから作業する経路）

**PC が無くても指示と対話ができるようにするための設定**（#259、2026-08-10）。
進め方の側は `docs/workflow.md` §9。

経路は2つあり、**必要なコンソール作業が違う。**

| | Claude Code on the web | `@claude`（GitHub Action） |
|---|---|---|
| 触る場所 | claude.ai/code / Claude モバイルアプリ | イシュー・PR のコメント欄 |
| 向く用途 | **腰を据えた対話。** 途中で方針を変えられる | **短い指示。** 1コメント1往復 |
| コードが動く場所 | Anthropic のクラウド VM | GitHub のホストランナー |
| リポジトリ側 | 不要 | `.github/workflows/claude.yml` |
| コンソール側 | GitHub App + **クラウド環境の setup script** | GitHub App + `CLAUDE_CODE_OAUTH_TOKEN` |

⚠️ **どちらも `main` のルールセットは同じように効く。**
PR 必須 / `check` 必須 / bypass なしなので、**ブラウザから直接 `main` を進めることはできない。**
スマホから最後にやるのは「CI が緑になった PR をマージする」だけ。

### 1. Claude GitHub App

https://github.com/apps/claude を `aiandrox/yaritai100list` にインストールする。
**両方の経路が同じ App を使う。**

権限は App 側で決まっていて**部分的に許可することはできない**
（Actions / Checks / Contents / Discussions / Issues / Members / Metadata /
Pull requests / Repository hooks / Workflows / Statuses）。

### 2. `CLAUDE_CODE_OAUTH_TOKEN`（`@claude` に使う）

**値はここに書かない。** サブスクリプション（Pro / Max）で認証するトークン。

```sh
claude setup-token          # 対話。出てきた値をコピーする
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

- **API キー（`ANTHROPIC_API_KEY`）は使わない。** 従量課金になる。
  サブスクのトークンなら消費するのはレート制限で、月額は増えない
- ⚠️ **`claude setup-token` を実行した人のサブスクに紐づく。** 期限が切れたら同じ手順で入れ直す
- ⚠️ **リポジトリは public。** `issue_comment` のシークレットは fork の PR でも読める文脈で走るため、
  **「誰が呼べるか」は action 側の判定に頼っている**（リポジトリへの write 権限が要る。bot は既定で拒否）。
  `claude.yml` の `if:` は**ランナーを起こさないための足切りで、認可ではない**

### 3. claude.ai/code のクラウド環境（web に使う）

claude.ai/code の入力欄の上にある雲アイコン → 環境の歯車 → 編集。
**設定ページや直リンクは無い。**

| 項目 | 値 |
|---|---|
| 名前 | `Default`（オンボーディングが作るもので足りる） |
| ネットワークアクセス | **`Trusted` のまま。** 下記のとおり必要な配布元は既定の許可リストに入っている |
| 環境変数 | **空にする。** 下記 |
| Setup script | 下記 |

#### Setup script

VM は Ubuntu 24.04、root で実行、**5分以内に終わって exit 0 する必要がある**
（非ゼロで終わるとセッションが起動しない）。1度成功するとスナップショットが再利用され、
以降のセッションでは走らない。

```bash
#!/bin/bash
set -eu

# 1. Node 24。VM の既定は 22。root の package.json は engines: ">=24"。
#    ⚠️ `n 24` だけでは効かない。n は /usr/local/bin に入れるが、
#    **PATH は /opt/node22/bin の方が先**（下記）。**PATH に載っている側を差し替える**
if npm install -g n && n 24 && /usr/local/bin/node -v; then
  for b in node npm npx corepack; do
    if [ -e "/usr/local/bin/$b" ]; then ln -sf "/usr/local/bin/$b" "/opt/node22/bin/$b"; fi
  done
fi

# 2. Deno（apps/render）。VM に入っていない。
#    🔴 公式の install.sh を使わない。あれは deno.land を叩くが、
#    deno.land は Trusted の許可リストに無い。npm 版なら registry.npmjs.org だけで済む
npm install -g deno

# 3. gh（docs/workflow.md がイシュー操作に使う）。VM に入っていない。
#    Ubuntu noble の universe に 2.45.0 がある。認証は要らない（プロキシが差し込む）。
#    🔴 **`apt-get update && apt-get install` と書かない**（下記）
apt-get update || true
apt-get install -y gh || true
```

#### 🔴 この script で2回踏んだこと（2026-08-10 に実測）

**どちらも `|| true` のせいでセッションは正常に起動し、入っていないことに気づけなかった。**

| 踏んだこと | 実際に起きていたこと |
|---|---|
| `n 24` を入れても `node -v` が 22 | **`n` は成功していた。** PATH が `/opt/node22/bin` を `/usr/local/bin` より先に見ていた |
| `apt install gh` が入らない | **`apt-get update` が非ゼロで終わっていた。** `&&` で `install` に到達しない |

PATH の実測値（先頭から）:

```
/root/.local/bin:/root/.cargo/bin:/usr/local/go/bin:/opt/node22/bin:/opt/maven/bin:
/opt/gradle/bin:/opt/rbenv/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:...
```

`apt-get update` が非ゼロで終わる理由は、**VM の sources に deadsnakes と ondrej の PPA が
入っていて、`ppa.launchpadcontent.net` がプロキシに 403 で弾かれる**ため。
`archive.ubuntu.com` / `security.ubuntu.com` 側は通っているので、**この失敗は無視してよい。**
だから `&&` ではなく `apt-get update || true` と行を分ける。

#### 最初のセッションで確かめること

script を変えると**スナップショットが作り直される**ので、
**反映されるのは次に新しく始めたセッションから**（いま開いているセッションでは変わらない）。

```sh
node -v && deno --version && gh --version
```

3つとも出れば成功。**`node` が 22 のままでも作業はできる**
（`engines` は npm の警告どまり）ので、そこで止まらずに進めてよい。

#### 環境変数を入れてはいけない

**クラウド環境に秘密の値の置き場所は無い。** その環境を使う人が誰でも読める。
`GOOGLE_CLIENT_SECRET` も `RENDER_HMAC_SECRET` も**ここには入れない。**

結果として、クラウドセッションでできないことがある:

- **Google ログインを通した動作確認**（`.dev.vars` が無い）。
  `docs/workflow.md` の「ログインが要る画面を撮る」はクラウドからはできない
- **本番へのデプロイ**（`CLOUDFLARE_API_TOKEN` が無い）。
  そもそもデプロイは `main` へのマージで走るので、要らない

**ローカル D1 を使う Vitest / Miniflare は動く**（秘密の値を要求しない）。

#### GitHub の扱いが普通と違う

- `GH_TOKEN` は `proxy-injected` という**プレースホルダ**。
  `gh` は通るが、**その値を直接読むスクリプトは動かない**
- **`git push` は、そのセッションのブランチにしか通らない**（プロキシの制限）
- **GraphQL は絞られている。** PR 関連の決まった問い合わせ以外は 403。
  `docs/workflow.md` §4 のサブイシュー紐付けは `gh api repos/{owner}/{repo}/...`（REST）なので通る

---

## Cloudflare

**設定済み**（#1、2026-08-06）。

| 項目 | 現在値 | 備考 |
|---|---|---|
| アカウント | `aiandrox7@gmail.com` | |
| Account ID | `89a295a0c7739f64b3bc773f09904aeb` | 秘密の値ではない |
| プラン | **Free**（2026-08-11〜08-14 だけ Workers Paid。解約済み） | 有料化は `TECH_STACK.md` §7 の判断が要る。経緯は下記 |
| Workers のサブドメイン | **`aiandrox`** | ホスト名は `yaritai100list.aiandrox.workers.dev` |
| カスタムドメイン | **使わない**（決定事項） | WAF とレート制限が使えない点は `TECH_STACK.md` §8 |

### D1

| 項目 | 現在値 | 備考 |
|---|---|---|
| データベース名 | `yaritai100list` | |
| `database_id` | `78718e38-9558-416b-b7c2-61b6a00be62d` | `wrangler.jsonc` にも書くのでコード側にも残る |
| リージョン | **`APAC`** | `wrangler d1 create` が自動選択した |
| バインディング名 | **`DB`** | `wrangler.jsonc` で指定。`wrangler d1 create` の出力例は `yaritai100list` になっているが採用しない |
| マイグレーション | **`0000_create_lists.sql` を適用済み**（2026-08-06） | `npm run db:migrate:remote --workspace @yaritai100list/web` |

### デプロイの状況

**2026-08-06 に初回デプロイを実施した。**

| 項目 | 値 |
|---|---|
| URL | https://yaritai100list.aiandrox.workers.dev |
| デプロイ方法 | **`main` へのマージで自動**（`.github/workflows/deploy.yml`、#117）。手動は `npm run deploy` |
| 確認済みの経路 | `/api/health` / `/api/health/db`（リモート D1 往復）/ `/`（SPA）/ `/lists`（SPA フォールバック）/ `/api/nope`（404）/ 静的アセット |

`SENTRY_DSN` は設定済み（2026-08-06、利用者が `wrangler secret put` で登録）。
**シークレットを登録すると新しいバージョンが自動でデプロイされる**（`deployments list` に
`Source: Secret Change` として残る）。再デプロイは不要。

### API トークン（コンソールで作る）

自動デプロイに使う。**ダッシュボード → My Profile → API Tokens → Create Token**。
`wrangler` の公式テンプレート「Edit Cloudflare Workers」ではなく、
**必要な権限だけを付けたカスタムトークン**にする。

| 種別 | 対象 | 権限 |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |

- **Zone の権限は要らない**（カスタムドメインを使っていないため。`TECH_STACK.md` §8）
- 作った値は GitHub の `CLOUDFLARE_API_TOKEN` に入れる（上記）。
  **1度しか表示されない。** パスワードマネージャに保存してから登録する
- 漏れた / 分からなくなったら、ダッシュボードで **Roll**（作り直し）してから登録し直す

#### クライアント IP アドレスフィルタリングは設定しない（2026-08-07 決定、#117）

**GitHub のホストランナーは IP が固定されない。**
範囲は `https://api.github.com/meta` の `actions` で公開されているが、
**数が多く、予告なく入れ替わる。** Cloudflare 側の一覧を追随させ続けるのは現実的ではなく、
**ずれた瞬間にデプロイが落ちる**（しかも原因がコードのどこにも無い、という一番たちの悪い壊れ方をする）。

固定 IP にするならセルフホストランナーが要る。個人開発で持つ費用と手間に見合わない。

**代わりに効かせていること:**

- **権限を絞る。** Workers Scripts と D1 の Edit だけ。**Zone の権限を付けていない**ので、
  DNS もキャッシュも WAF も触れない。漏れても壊せる範囲がこのワーカーとその DB に限られる
- **渡す場面を絞る。** `deploy.yml` は `push: main` と手動実行のみ。
  **fork からの PR にシークレットは渡らない**（GitHub の仕様）
- **すぐ捨てられる。** 疑わしければ Roll する。復旧は `gh secret set` の1回

⚠️ **残っている現実的な露出は、CI で動く依存パッケージ。**
`npm ci` の postinstall や、ビルド時に走るコードは同じジョブの環境変数を読める。
`--ignore-scripts` にすると `workerd` などのバイナリが用意されず動かないため、外していない。
**ここは「Dependabot で更新を追う」以上の対策を取っていない**（`TECH_STACK.md` §9）。

#### 有効期限（TTL）も設定していない

期限切れは**デプロイのワークフローが赤くなる**ので気づけるが、
「なぜ落ちたか」を思い出すコストの方が、期限を切って得られる安全より大きいと判断した。
**使わなくなったら Roll ではなく削除する。**

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

**設定済み**（#1、2026-08-06）。

**OAuth クライアントを development / production で分けている。**
GCP プロジェクトは1つ（同意画面はプロジェクト単位で共有されるため、分けると設定漏れの面が増える）。

| | production | development |
|---|---|---|
| Client ID | `360816377904-1h28d71uu6q42a1ggi1j8hdjquerhr34.apps.googleusercontent.com` | `360816377904-5jhsstvqt3313uvnv5g6n7k0vu2m8t2b.apps.googleusercontent.com` |
| 種類 | ウェブアプリケーション | ウェブアプリケーション |
| 承認済みリダイレクト URI | `https://yaritai100list.aiandrox.workers.dev/api/auth/callback/google` | `http://localhost:5173/api/auth/callback/google` |
| 承認済みの JavaScript 生成元 | **空** | **空** |
| Client Secret の置き場所 | Workers のシークレット | `.dev.vars` |
| 登録状況 | **登録済み**（2026-08-06） | **登録済み**（2026-08-06） |

同意画面は **外部 / 公開**。

**development のポートは 5173（Vite）。** #17 で dev サーバーを `wrangler dev`（8787）から
Vite に変えたため、2026-08-06 に GCP 側のリダイレクト URI も 8787 から 5173 に直した。
`npm run dev` のポートを変えるときは、ここと GCP の設定の両方を直す。

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

---

## Deno Deploy（画像生成）

**organization**（#1、2026-08-06）と**アプリ**（#172、2026-08-08）の両方を作成済み。

| 項目 | 現在値 | 備考 |
|---|---|---|
| コンソール | https://console.deno.com | Classic（`dash.deno.com`）は 2026-07-20 廃止 |
| organization slug | **`aiandrox`** | |
| プラン | **Free** | 🔴 **クレジットカード登録が要る。** 未登録だと Free の上限の **1%** しか使えない（下記） |
| アプリ名 | **`yaritai100list-render`** | **この名前で作る**（`RENDER_URL` がこの名前を前提にしている） |
| ホスト名 | `yaritai100list-render.aiandrox.deno.net` | |
| HMAC 鍵の名前 | `RENDER_HMAC_SECRET` | Cloudflare 側と同じ値を共有する。値はここに書かない。**両側とも設定済み**（2026-08-08） |

#### 🔴 組織を認証しないと Free の上限の 1% しか使えない

2026-08-06 の調査では「クレジットカード登録は不要」と書いたが、**足りなかった。**
支払い方法を登録するまで、Billing に次の但し書きが出る。

> Your organization is not verified, so you can only use 1% of the Free plan limits
> until you add a valid payment method.

| | 本来の Free | 未認証（1%） |
|---|---|---|
| リクエスト | 1M / 月 | **10k / 月** |
| Outbound Traffic | 20GB / 月 | **200MB / 月** |
| CPU time | 15h / 月 | **9分 / 月** |

⚠️ **超えるとアプリが止まる**（課金されるのではない）。止まると全リクエストがこう返る:

```
503 USAGE_EXCEEDED
This application is suspended due to usage limits being exceeded.
```

2026-08-08 に実際に踏んだ。**アプリが返したのは 82KiB だけで、枠を食ったのはビルド**
（当時 Install command が `npm install` で、ビルドのたびに monorepo を丸ごと落としていた。#182）。
**カードを登録して解消**。プランは Free（$0）のまま。

### アプリを作るときの設定（#172、2026-08-08 に設定済み）

コードは `apps/render` にある。**コンソールで作るときに指定したもの:**

| 項目 | 値 | 理由 |
|---|---|---|
| アプリ名 | **`yaritai100list-render`** | `RENDER_URL` がこの名前を前提にしている |
| リポジトリ | `aiandrox/yaritai100list` | |
| ルートディレクトリ | **リポジトリの root（`.`）** | ⚠️ `apps/render` にすると **`packages/shared` が見えなくなる** |
| エントリポイント | **`apps/render/main.ts`** | |
| 環境変数 | `RENDER_HMAC_SECRET` | **Cloudflare 側と同じ値**（値はここに書かない） |
| インストールコマンド | **空にする** | 🔴 `apps/render/deno.json` に `"nodeModulesDir": "none"` を入れてあるので `npm install` は要らない。**入れたままにすると、ビルドのたびに monorepo 全部を落としてきて転送量を食う**（#182） |
| ビルドコマンド | なし | Deno なのでビルド不要 |

**デプロイは Deno Deploy の GitHub 連携に任せる**（`main` への push で出る）。
Cloudflare 側（`.github/workflows/deploy.yml`）とは別系統になるが、
**画像生成は状態を持たない単一エンドポイント**なので、順序を揃える必要がない。

### コンソールでしか触れないもの

- **organization slug。** デフォルトドメインが `{app-name}.{org-slug}.deno.net` になる。
  変更すると既存 URL が全部壊れる（TLS 再発行に数分）。
  ただしこの URL は Cloudflare 側の環境変数に入るだけで外部に共有されないため、変更コストは低い
- アプリの環境変数（`RENDER_HMAC_SECRET`）

### ⚠️ Deno Deploy 側に置いてよいものの境界

**`yaritai100list-render` は状態を持たないレンダラである。API・認証・DB を置かない。**

`TECH_STACK.md` §7「なぜ BE を分けないか」のとおり、フロントと API を別ドメインに置くと
`SameSite=None` の Cookie、ローカルでの https、CORS の origin 設定がまとめて必要になり、
**どれも型でもテストでも捕まえにくい設定ミス**を生む。
それを構造的に避けるために、**API・認証・DB はすべて Cloudflare Workers 側**に置くと決めている。

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

**Workers 用プロジェクトまで設定済み**（#1、2026-08-06）。

| 項目 | 現在値 | 備考 |
|---|---|---|
| organization | **既存のものを流用**（`match-party` と同じ org） | 下記の枠の注意を参照 |
| プラン | Developer（無料） | **5,000 errors/月・1ユーザー・保持30日**（2026-08-06 時点） |
| Workers 用プロジェクト | **`yaritai100list-workers`** | プラットフォームは `Cloudflare Workers`（`@sentry/cloudflare`） |
| Deno 用プロジェクト | **未作成。#8 で作る** | プラットフォームは `Deno`（`@sentry/deno`） |
| SPA（ブラウザ）用プロジェクト | **作らない（未決）** | 下記 |
| Spike Protection | **有効**（`yaritai100list-workers`） | |
| アラート | 作成時の既定ルール（新規イシューでメール通知） | **消さないこと。これが「壊れたことを知る手段」そのもの** |
| DSN の置き場所 | `SENTRY_DSN`（シークレット扱い） | 値はここに書かない |

## Workers AI（#253）

取り入れ面に出してよいかの判定に使う。**コンソールでの設定は要らない**
（`wrangler.jsonc` の `"ai": { "binding": "AI" }` だけ）。ここに書くのは**枠と落とし穴。**

| | 2026-08-11 に実測した値 |
|---|---|
| 無料枠 | **10,000 Neurons/日** |
| 使っているモデル | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 1回の判定 | **約 26.6 Neurons**（入力 804 トークン・出力 25 トークン） |
| 1日に判定できる数 | **約 370 件** |
| バッチの設定 | 1時間ごと × **12件** = 288件/日（約 7,700 Neurons） |

🔴 **見積もりで決めないこと。** 文字数から計算したときは 48 Neurons と出したが、
実測は 26.6 だった（**6割の外し**）。応答の `usage.neurons` に実際の値が入っている。

🔴 **モデルは非推奨になる。**
最初に選んだ `@cf/meta/llama-3.1-8b-instruct` は **2026-05-30 に非推奨**で、
呼ぶと `AiError 5028` で落ちた（2026-08-10 に踏んだ）。

- **落ちても「出さない」として保存はしない**ので、誤った判定が焼き付くことはない
- ただし**判定が全く進まなくなる。** `pool-judge: failed=` がログに出続ける

🔴 **枠を使い切ると `AiError 4006` で、その日はもう1件も判定できない**
（2026-08-10 に実測。検証で使い切った）。
判定が止まってもプールは古い判定で埋まったままなので画面は壊れないが、
**新しく書かれた本文がいつまでも出てこない。**

🔴 **精度と件数は同じ枠を取り合っている。**
#264 でプロンプトを長くしたぶん、1件あたりが **20 → 26.6 Neurons** に増えた。
`POOL_JUDGE_BATCH_SIZE` を **12**（288件/日 = 約 7,700 Neurons）にしてあるのはこのため。

⚠️ **プロンプトを長くしたら、必ずバッチの件数を見直すこと。**
見直さないと、途中で枠を焼いて残りの時間が無駄になる。

### 🔴 検証で本番の枠を焼かないこと（2026-08-10 に踏んだ）

**手元でプロンプトを試すのも、本番のバッチも、同じ 10,000 Neurons/日を使う。**
#264 のプロンプトを 151 件で検証したところ**その日の枠を使い切り、
本番の判定が9時間止まった**（`AiError 4006`）。

- 151 件を通すと **約 4,000 Neurons**。本番が 1日 7,700 使うので、**同じ日には2回も回せない**
- ⚠️ **ダッシュボードの「今日使用されたニューロン」が 0 に戻っても、API はまだ 4006 を返した。**
  表示の集計と枠の判定はずれる。**表示を見て「復活した」と判断しない**
- 検証を回す前に、**その日にバッチが何件判定するかを数えてから**枠に収まるか確かめる

### Workers Paid を一時的に契約した経緯（#270）

**2026-08-11 に契約し、2026-08-14 に解約した**（コンソールの表示は「終了中」。
期間の終わりまでは有料のまま動き、そのあと Free に戻る）。

| | 判断 |
|---|---|
| なぜ契約したか | 上の 4006 で判定が止まり、**#264 の入れ替えを走り切らせるため** |
| 何が変わったか | **Neurons の1日の枠は変わらない**（有料でも 10,000/日）。増えるのは超過分を $0.011/1,000 で買えることだけ |
| なぜ戻せるか | 入れ替えが 2026-08-11 に完走し、**定常では新しく書かれた本文しか判定しない**（消費はほぼ 0） |

🔴 **`POOL_JUDGE_BATCH_SIZE` を有料の間に上げないこと。**
上げたまま Free に戻ると、その日のうちに枠を焼く。**有料は «余裕» であって «前提» ではない。**

### モデルやプロンプトを変えるとき（#254 / #264）

🔴 **定数を書き換えるだけ。他は何もしない。**

| 変えるもの | 書き換える定数 |
|---|---|
| モデル | `apps/web/src/pool-judge.ts` の `POOL_JUDGE_MODEL` |
| プロンプト | `packages/shared/src/pool-text.ts` の `POOL_JUDGE_PROMPT_VERSION` |

`wish_texts` に「何で判定したか」（`model` と `prompt_version`）が入っているので、
バッチが**古い行を少しずつ拾い直す**（1時間に 12 件）。
**上書きされるまで古い判定が使われる**ので、入れ替えの最中もプールは埋まったまま。

🔴 **プロンプトの中身を変えたら必ず版を上げること。** 上げないと、
**同じモデルのままなので「判定済み」と見なされ続け、直した結果が1件も反映されない**
（#264 でこの穴を踏んだ）。

⚠️ **拾い直しはまだ判定していない本文の後回しになる**（そちらが先）。
1万件あれば入れ替わりきるのに 35 日かかるが、**その間も取り入れ面は動いている。**

**実績**（#264、2026-08-11）: 151 件の入れ替えに **約 13 時間**。
その間プールは 138〜142 行を保ち、**空になった瞬間は無かった。**

### ⚠️ 同じプロンプトでも答えは揺れる（2026-08-10 に実測）

同じ本文を2回投げると別の代表表現が返ることがある
（「英語を話せるようになる」が、通ったり `英語を話す` になったりした）。
**プロンプトは平均を上げるだけで、下限は上げない。**

だから2段構えにしてある。

1. プロンプトで「意味を変えるな。迷ったら元の文のまま」と指示する。
   🔴 **実際に入っている本文を例として並べないこと**（2026-08-11 の利用者の指摘）。
   それは覚えさせているだけで、**例に無い本文が来たときに効くかを判断できない。**
   例を出すなら `〇〇` のような形にして、**規則として書く。**
   評価も、**例を取った本文とは別に用意した文で行う**（同じ本文で測ると点が高く出る）
2. **機械的に分かるものはコードで止める**（`toPoolJudgement` の `isTruncation`。
   代表表現が元の文の部分文字列なら、言葉を削っただけなので採用しない）

それでもすり抜けるものはある。**1件だけ直すなら下の「出してはいけないものが〜」、
全体の傾向を直すならプロンプトの版を上げる。**

### 🔴 `wish_texts` を一括で消さないこと

**やってはいけない。**

```sh
# 🔴 これをやると取り入れ面が空になる
wrangler d1 execute DB --remote --command "delete from wish_texts"
```

プールは `wish_texts` から作り直すので、消すと**次のバッチでプールが空になる。**
判定は**1日 360 件**しか進まないので、1万件あれば**28日間、取り入れ面が空**のまま。

モデルやプロンプトを変えたいだけなら上の節。消す必要は無い。

### 出してはいけないものが出てしまったとき

AI の判定をすり抜けることはある。**2箇所直す。片方だけでは直らない。**

```sh
# 1. いま出ているものを消す（即座に効く）
wrangler d1 execute DB --remote --command \
  "delete from pool where canonical = '...'"

# 2. 次のバッチで戻ってこないようにする
wrangler d1 execute DB --remote --command \
  "update wish_texts set verdict='ng', canonical=null, genre=null where raw_text = '...'"
```

- **1 だけ**だと、次のバッチ（最大1時間後）で戻ってくる
- **2 だけ**だと、消えるまで最大1時間かかる

⚠️ **`raw_text` は書かれたままの本文**（正規化前）。同じ意味でも表記が違えば別の行なので、
`like` で拾うか、`pool` の `canonical` から辿って該当する `wish_texts` を全部直す。

### ⚠️ 無料枠の 5,000 errors/月は**プロジェクト間で共有**

**同じ organization に無関係のプロジェクト `match-party` がある。**
枠はプロジェクト単位ではなく organization 単位なので、
**`match-party` がエラーを吐くと `yaritai100list-workers` の通知が死ぬ。逆も同じ。**

プロジェクトを分けても枠は増えない。**エラーループが起きると1日で枠を焼き切って、
以降の障害に気づけなくなる。**「壊れたことを知る手段」が目的なので、ここが潰れると本末転倒。

対策:

- **Spike Protection を有効にした**（設定済み）
- 枠が足りなくなったら、organization を分けるか、クライアントキーごとのレート制限を設定する

### DSN をシークレット扱いにする理由

DSN はブラウザに埋め込む前提の値なので一般には秘密ではない。
ただし**このリポジトリは public** で、かつ**無料枠が 5,000 errors/月しかない**。
DSN が漏れると第三者にイベントを送り込まれて枠を焼かれ、
**通知が目的なのに通知が死ぬ**状態になる。

そのため `wrangler.jsonc` の `vars`（＝コミットされる）ではなく、
**`wrangler secret put SENTRY_DSN` で入れる。**

### SPA（ブラウザ側）のエラーは送らない（2026-08-06 決定、#18）

ブラウザのエラーは拡張機能やネットワーク起因のノイズが多く、**5,000 の枠を食い潰しやすい**。
枠を焼くと以降の障害に気づけなくなるため、**サーバー側だけで運用する。**

再考する条件: 利用者から「動かない」と言われたのに Workers 側に何も記録が無い、
という状況が実際に起きたとき。そのときは SPA 用のプロジェクトを別に作り、
`ignoreErrors` でノイズを削ってから入れる。

### 到達確認の結果（2026-08-06、本番で実施）

**届いた。** 一時的に例外を投げるルートを本番に出して確認し、確認後すぐ削除した。

| 確認項目 | 結果 |
|---|---|
| イベントの到達 | ✅ `YARITAI100LIST-WORKERS-1` として2件。**叩いた回数と一致（重複なし）** |
| environment | ✅ `production` |
| transaction | ✅ `GET /api/dev/boom` |
| url | ✅ 送られている（`shareId` を隠さない方針どおり） |
| リクエストボディ・Cookie | ✅ 含まれていない |

**このとき `withSentry` だけでは通知が飛ばない可能性に気づいた。**
Hono は例外を自前で捕まえて 500 を返すため、Sentry から見ると「成功したリクエスト」になる。
`app.onError` で明示的に `captureException` する形に直してから確認した（#47）。

#### `user` に IP が入る（実害なし）

イベントの `user` に `2a06:98c0:3600::103` が入っていた。これは **Cloudflare のエッジ自身の
IPv6**（`2a06:98c0::/29` は Cloudflare の範囲）で、**利用者の IP ではない。**
Worker から Sentry へ送信するため、Sentry が送信元 IP を推測して埋めたもの。

`dataCollection.userInfo: false` と `beforeSend` のユーザー情報の除去は効いており、
SDK 側は何も送っていない。消したい場合は
**Settings → Security & Privacy → Prevent Storing of IP Addresses** で止められる（未設定）。

### `user.id` が届くかの確認結果（2026-08-06、本番で実施。#52 / #64）

**届いた。** `dataCollection.userInfo: false` は、**明示的な `Sentry.setUser({ id })` は落とさない。**
自動で集めるユーザー情報を止めるだけで、こちらが入れた値は残る。

| 経路 | イベント | `user.id` |
|---|---|---|
| `requireUser` を通った実ログイン（`authorization.ts` の `setUser`） | `YARITAI100LIST-WORKERS-2` | ✅ Better Auth の実 ID |
| 認証なしの確認用ルート（合成 ID を直接 `setUser`） | `YARITAI100LIST-WORKERS-1` | ✅ 合成 ID |

- **名前・メールは付いていない**（`scrubEvent` が `id` 以外を落とす方針どおり）
- `user` に IP と geo が付くのは上記のとおり Cloudflare エッジの IP。利用者のものではない
- 確認に使った `/api/dev/sentry-check` は**確認後に削除した。**
  `requireUser` の後ろに置いた版は、**本番のセッション Cookie を AI 側では作れない**ため
  （`BETTER_AUTH_SECRET` を持っていない）叩けず、利用者に叩いてもらう必要があった。
  同種の確認をするなら、認証を外した合成 ID の版の方が AI だけで完結する

### 通知が実際に届くかの確認手順（再確認したいとき）

**この確認には DSN が必要なので、コードだけでは完結しない。**
自動テストで検証しているのは「DSN が無ければ SDK を初期化しない」「送る前に
ボディ・Cookie・ヘッダ・ユーザー情報を落とす」までで、**到達の確認は手作業。**

1. `apps/web/.dev.vars.example` を `.dev.vars` にコピーし、`SENTRY_DSN` に値を入れる
   （`SENTRY_ENVIRONMENT=local` も入れて本番のイベントと混ざらないようにする）
2. `apps/web/src/index.ts` に**一時的に**例外を投げるルートを足す
   ```ts
   .get('/api/dev/boom', () => {
     throw new Error('Sentry の動作確認')
   })
   ```
   （恒久的に置かない。公開されたエラー発生器になり、無料枠を焼かれる）
3. `npm run dev` → `curl http://localhost:5173/api/dev/boom`
4. Sentry の `yaritai100list-workers` にイベントが届くこと、
   **リクエストボディと Cookie が含まれていないこと**を目で確認する
5. 一時的なルートと `.dev.vars` の DSN を消す

---

## シークレットの置き場所

**値はこのファイルに書かない。** 名前と置き場所だけを記録する。

| 名前 | 用途 | ローカル | 本番（Workers） | 本番（Deno Deploy） |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth（**環境ごとに値が違う**） | `.dev.vars` | `wrangler.jsonc` の `vars` | — |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | `.dev.vars` | `wrangler secret put` | — |
| `BETTER_AUTH_SECRET` | セッション署名 | `.dev.vars` | `wrangler secret put` | — |
| `RENDER_HMAC_SECRET` | 画像生成の署名（**両側で同じ値**） | `.dev.vars` | `wrangler secret put` | コンソールの環境変数 |

### ⚠️ `wrangler secret put` は空の値を黙って受け付ける

入力が隠されるプロンプトなので、**端末によっては貼り付けが効かない。**
気づかず Enter を押すと**空の値が保存され、`wrangler secret list` には名前が出る**
（存在するのに中身が空）。2026-08-08 にこれで詰まった。

貼り付けを介さずに入れる:

```
cd apps/web && printf '%s' '<値>' | npx wrangler secret put RENDER_HMAC_SECRET
```

🔴 **`echo` を使わない。** 末尾に改行が付いて、署名が合わなくなる。

**反映にデプロイは要らない**（新しいバージョンが作られて即座に 100% 配信される）。
| `RENDER_URL` | 画像生成サービスの URL。**秘密ではないので `wrangler.jsonc` の `vars`**（#172） | `.dev.vars` で上書き可 | `wrangler.jsonc` の `vars` | — |
| `SENTRY_DSN` | エラー通知（**シークレット扱い。理由は Sentry の節**） | `.dev.vars` | `wrangler secret put` | コンソールの環境変数 |

変数名は #3 / #8 / #18 での想定。**確定したらこの表を更新する。**

- **ローカル:** リポジトリ直下の `.dev.vars`。`wrangler dev` が読む。**`.gitignore` に入れる**
- **本番（Workers）:** `npx wrangler secret put <NAME>`。
  **Worker がデプロイされた後でないと実行できない**（シークレットは Worker スクリプトに紐づくため）
- シークレットを受け取ったら、まず**パスワードマネージャに保存する**。
  ダウンロードした JSON は `~/Downloads` から削除する（同期対象になりがちなため）

---
