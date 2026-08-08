/**
 * ID を作る唯一の場所。
 *
 * **推測不可能な値を使う。連番を露出させない**（`CLAUDE.md` の不変条件）。
 * 連番だと、他人のリストや項目の**存在と件数が URL から分かってしまう。**
 *
 * `crypto.randomUUID()` は Workers でも Deno でも使える（`packages/shared` と違い
 * ここは Worker 専用だが、経路を揃えておく）。
 *
 * 公開用の `shareId` は `newShareId()`（下）。**用途が違うので分けてある。**
 */
export function newId(): string {
  return crypto.randomUUID()
}

/**
 * 公開用の ID（`shareId`）。**編集用の `listId` とは別の値**（`TECH_STACK.md` §7）。
 *
 * 分ける理由は2つ:
 *
 * - **作り直すだけで共有リンクを無効にできる。**
 *   「うっかり送った相手に見られ続ける」状態から抜ける手段（`PRODUCT_SPEC.md` §5.1）
 * - 公開 URL から編集 URL を推測できない
 *
 * 16バイト（128ビット）を16進で。**総当たりで当てられる長さではない。**
 * UUID にしないのは、URL に載る値なので区切りの `-` が邪魔なため。
 * マイグレーション（`0007`）で既存の行に入れた値と**同じ形**にしてある。
 */
export function newShareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))

  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
