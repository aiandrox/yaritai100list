# 開発の進め方

**セッションをまたいで作業を続けるための手順書。**
「次に何をやるか」「どうやって取り込むか」「いつ完了と言えるか」だけを扱う。
何を作るかは `PRODUCT_SPEC.md`、どう作るかは `TECH_STACK.md`。

前提として `CLAUDE.md` の「不変条件」を読んでいること。

---

## 1. セッションの最初にやること

```sh
git status && git log --oneline -5          # 今どこにいるか
gh issue list --state open --milestone MVP  # 残っている作業
gh issue view <N> --comments                # 進行中イシューの前回のログ
```

**進行中のイシューがあれば、そのコメントを読んでから始める。**
前回どこで詰まったか・何を判断したかはそこに書いてある（§2）。

初回、または仕様の記憶が怪しいときは `PRODUCT_SPEC.md` → `TECH_STACK.md` を読む。

## 2. 進捗の所在は GitHub イシュー

- **親イシュー #1〜#10 が機能単位。** 本文のチェックリストが作業項目
- 進捗はイシュー本文のチェックボックスを更新して表す
- **詰まった点・判断した点・後回しにした点はイシューにコメントで残す。**
  次のセッションはこれを読んで再開する
- **`MEMO.md` にチェックリストを増やさない。** 進捗の記録先は GitHub に1本化する

コメントに書く価値があるのは、コードを読んでも分からないこと。
「この方法を試して駄目だった」「この値はこう決めた」「ここは次のイシューに回した」。

## 3. どのイシューから着手するか

```
#1 事前準備
 └ #2 土台
     ├ #3 認証 ─┐
     └ #4 未ログイン編集 ─┴ #5 永続化と引き継ぎ ─ #6 マイリスト  ← ここまで MVP
                                                    └ #7 共有
                                                        ├ #8 OGP 画像 ─ #9 ダウンロード画像
                                                        └ #10 取り入れ面
```

- **同時に進めるイシューは1つ。** #3 と #4 は依存がなく並行可能だが、1セッションで両方を触らない
- **Post-MVP（#7〜#10）は #6 まで終わるまで着手しない**
- #9 は #8 の後。順序を入れ替えるとフォントとラスタライズの土台の作業が #9 に前倒しになる

## 4. 着手時にサブイシューへ分割する

親イシューは粗い。着手したら本文のチェックリストを見て、**1 PR で収まる単位**のサブイシューを切る。

```sh
# 子イシューを作る
gh issue create --title "Vitest + Miniflare のテスト基盤" \
  --label infra --milestone MVP --body "親: #2 ..."

# 親に紐付ける（sub_issue_id は子の id。issue number ではない）
CHILD_ID=$(gh api repos/aiandrox/yaritai100list/issues/12 --jq .id)
gh api repos/aiandrox/yaritai100list/issues/2/sub_issues -F sub_issue_id=$CHILD_ID
```

分割の目安は **1サブイシュー = 1 PR = テストまで含めて緑にできる大きさ**。
分割せずに親イシューを直接1 PR で片付けられるなら、それでよい（#1 は分割不要）。

## 5. 1サブイシューあたりの流れ

```sh
git switch -c 12-vitest-miniflare              # <イシュー番号>-<英小文字の slug>

# 実装する。テストを同じ PR に含める
npm run typecheck && npm run lint && npm test  # ローカルで緑にしてから出す

git commit -m "..."
gh pr create --fill --body "Closes #12"         # 🔴 日本語にしない。閉じなくなる

# CI を待つ。**待っている間に手を止めない**（2026-08-08 の利用者の指示）
until gh pr checks 2>/dev/null | grep -qE '^check\s+(pass|fail)'; do sleep 10; done

gh pr update-branch                             # main が進んでいたら追随させる
gh pr merge --squash --delete-branch
```

⚠️ **`gh pr checks --watch` で待ち続けない。** 出しっぱなしにして別の作業に移り、
上のような形で様子を見る。`--watch` は**直前の実行結果を拾って即座に返ることもある**ので、
push 直後に叩いたときは `gh run list --branch <branch> --limit 1` で
新しい実行が始まっているか確かめる。

- 🔴 **`Closes #12` は英語のまま書く。** 「閉じる: #12」ではイシューが閉じない。
  GitHub が見るのは `close` / `fix` / `resolve` 系の英単語だけ。
  2026-08-08 に #180 / #182 / #185 を閉じ忘れた（マージ後に手で閉じた）
- **`main` に直接コミットしない。** 人間のレビューはないが、**PR は CI のゲート**として使う
- **CI が赤のままマージしない。** 落ちたテストを skip して通すのも同じこと
- **テストを書かずに機能を入れない。** 特に認可（§6）
- 1 PR が大きくなりすぎたら、途中で切ってサブイシューを増やす
- **画面や挙動に関わる PR も、確認を待たずにマージしてよい**（2026-08-06 の利用者の判断）。
  見た目の確認は本番で行う。直す必要があれば別の PR にする

### 見た目を変えたら、実物を PR に貼る

⚠️ **テストは見た目を守らない**（§6 と `TECH_STACK.md` §10）。
「クラスが付いている」ことしか見ておらず、**溢れ・詰まり・読みにくさは画像を見るまで分からない。**
実際に #190 では 25行目が余白を突き抜けたまま、テストは全部緑だった。

**ローカルの `npm run dev` に Chrome を繋いで撮る**（2026-08-08、#216）。
Playwright は**リポジトリの依存に入れない**（この用途にしか使わないので `/tmp` に置く）。
ブラウザも**手元の Chrome を使う**（`channel: 'chrome'`。ダウンロードが要らない）。

```sh
cd /tmp && npm i playwright-core
```

```js
// /tmp/shot.mjs
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({ channel: 'chrome' })
// 主対象はモバイル縦1カラム（PRODUCT_SPEC.md §4.5）。**その幅で撮る**
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'ほかにできること' }).click()   // 操作してから撮る
await page.screenshot({ path: '/tmp/shot.png' })
await browser.close()
```

貼り方:

- 画像は **`previews` ブランチ**（`main` から切り離した置き場）に置き、raw URL で参照する。
  🔴 **`main` に入れない。** デザインを直すたびに増えてリポジトリが重くなる
- ⚠️ **同じファイル名で差し替えない。** GitHub が画像をキャッシュしていて、
  force push しても**古い画像が出続ける。** 直したら `-2` のように名前を変える

### デプロイ

**`main` にマージすると自動で出る**（2026-08-07、#117）。`.github/workflows/deploy.yml`。

```
チェック → リモートのマイグレーション → デプロイ → 疎通確認
```

**手で叩く必要はない。** マージしたら `gh run list --workflow Deploy --limit 1` で結果を見る。

- **順序は固定してある。** スキーマを変えたときは**マイグレーションが先**。
  逆にすると、新しいコードが存在しない列を読んで落ちる
- **デプロイ前にもう一度チェックを走らせている。**
  PR 単体では緑でも、**続けてマージした2つが噛み合わないことがある**
- 落ちたら `gh workflow run Deploy` で流し直せる
- 本番 URL: https://yaritai100list.aiandrox.workers.dev

手で出したいとき（ワークフローが壊れている場合など）:

```sh
npm run deploy                                       # vite build + wrangler deploy
npm run db:migrate:remote --workspace @yaritai100list/web   # スキーマを変えたときだけ
```

- **デプロイ直後の数秒は 404 や `error code: 1042` が返る。**
  伝播待ちなので、失敗と判断せず 10 秒ほど待って叩き直す（実際に踏んだ）
- **シークレット（`SENTRY_DSN` など）は AI では設定できない。**
  値を持っていないため。必要になったら利用者に
  `wrangler secret put <名前>` の実行を依頼する

### ローカルで詰まったとき

**コードを読んでも分からない類**なので残しておく（README から移した）。

- **`no such table` が出たら `db:migrate` を忘れている。**
  ローカル D1 の保存先は `wrangler.jsonc` の `database_id` ごとに分かれるため、
  **その値を変えると空のデータベースに切り替わる**（`.wrangler/state/` 配下）。
  テストは別のインメモリ D1 を使うので、**テストが緑でもこの状態は起こりうる**
- **Vite の dev サーバーは IPv6（`[::1]`）でだけ listen する。**
  `curl http://127.0.0.1:5173` は接続できない。`localhost` を使う
- **デプロイ直後の数秒は 404 や `error code: 1042` が返る。** 伝播待ち（上記）

### 依存関係を触るとき

**`package-lock.json` を作り直さない。** 削除して `npm install` し直すと、
**この環境では大量の `resolved` / `integrity` が失われる**（実測: 3120行削除・553行追加、
解決されるバージョンは同一）。integrity が無い lock は供給元の検証ができなくなるので、
作り直してしまったら `git checkout package-lock.json` で戻して `npm ci` する。

依存を足すときは `npm install --workspace <名前> <パッケージ>` を使う（lock は差分更新される）。

**`overrides` は効かない。** npm 11.3.0 では、`overrides` を書き換えても再解決の理由として
検出されない（あり得ないバージョンを指定しても `up to date` で通過する）。
lock を作り直しても honor されなかった。**推移的な依存のバージョンを強制する手段は無いものとして扱う**（#29）。

**例外はない。ドキュメントのみの変更も PR を通す。**
`main` にはルールセットが設定されており（`docs/console-settings.md`）、
PR 必須・CI 必須・force push 禁止で、**bypass できるアクターもいない**。
直接 push しようとすると GitHub 側で拒否される。

## 6. 完了の条件（全イシュー共通）

これを満たさないイシューは閉じない。

- [ ] ローカルで typecheck / lint / test が緑
- [ ] `wrangler dev` で実際に動くことを確認した（テストだけで済ませない）
- [ ] **イシュー本文の「完了条件」のテストが存在して通る**
- [ ] 認可に関わる変更なら、**「通らないこと」のテストがある**（成功パスだけ書かない）
- [ ] 仕様・構成の判断を変えたなら `PRODUCT_SPEC.md` / `TECH_STACK.md` の**決定事項の表を更新した**
- [ ] コンソールでしか設定できない項目を触ったなら `docs/console-settings.md` を更新した
- [ ] イシュー本文のチェックボックスを埋め、判断のログをコメントに残した

## 7. ラベルとマイルストーン

| ラベル | 用途 |
|---|---|
| `epic` | 機能単位の親イシュー（#1〜#10）。サブイシューには付けない |
| `setup` | アカウント・コンソール設定 |
| `infra` | 開発環境・テスト基盤・CI |
| `auth` | 認証・セッション |
| `list` | リストと項目の編集 |
| `share` | 公開・共有 |
| `image` | OGP・ダウンロード画像 |
| `discover` | 取り入れ面 |
| `security-test` | **認可・セキュリティのテストを含む。** これが付いたイシューはテストなしで閉じない |

マイルストーンは `MVP`（#1〜#6）と `Post-MVP`（#7〜#10）の2つ。
サブイシューには親と同じマイルストーンを付ける。

## 8. 迷ったときの優先順位

1. **`CLAUDE.md` の不変条件を破らない。** 破る必要が出たら、先にドキュメントを更新して理由を残す
2. **テストが書けない設計を選ばない。** レビューする人間がいないので、テストが唯一の安全網
3. ドキュメントの「決定事項」に従う
4. **未決の論点を黙って決めない。** 決めたら `PRODUCT_SPEC.md` §7 /
   `TECH_STACK.md` §12 の表に書く。判断が必要なだけで進められないなら、そこで人間に聞く

判断を人間に確認すべきものの例:
- 月額が ¥0 を超える選択（Cloudflare Workers Paid への移行など）
- 公開範囲・データの取り扱いに関わる仕様変更

## 9. この手順書について

進め方を変えたらこのファイルを更新する。
ここに書いていないローカルの思いつきは、次のセッションには残らない。
