/**
 * ID を作る唯一の場所。
 *
 * **推測不可能な値を使う。連番を露出させない**（`CLAUDE.md` の不変条件）。
 * 連番だと、他人のリストや項目の**存在と件数が URL から分かってしまう。**
 *
 * `crypto.randomUUID()` は Workers でも Deno でも使える（`packages/shared` と違い
 * ここは Worker 専用だが、経路を揃えておく）。
 *
 * ⚠️ **公開用の `shareId`（#7）はここを使い回さない。**
 * あちらは人が触る URL に載るので短さと読みやすさの要求が違う。
 * 別の関数として、この隣に足すこと。
 */
export function newId(): string {
  return crypto.randomUUID()
}
