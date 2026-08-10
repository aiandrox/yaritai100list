-- 本文を書き換えたら取り入れの関係を消す（#234 / 親 #10）。
--
-- 🔴 **アプリのコードではなくトリガーにする**（2026-08-10）。
-- 取り入れは本文をコピーする操作で、**コピーした側が本文を書き換えたら
-- それはもう取り入れた項目ではない**（2026-08-07 の判断。#87）。
--
-- 置き場所の候補は2つあった:
--
--   1. `PATCH /api/lists/:listId/items/:itemId` のハンドラで消す
--   2. トリガー
--
-- **2 を選んだ理由:**
--
-- - #87 の判断が「**`items` の更新経路に後始末を紛れ込ませない**」だった。
--   1 はまさにそれをやることになる
-- - 本文を書き換える経路は `PATCH` だけとは限らない。**取り込み（`/restore`）や
--   将来の一括操作が増えるたびに書き忘れが起きる。** トリガーなら経路を問わない
-- - `lists.share_id` の必須チェック（0007）でも同じ理由でトリガーを使っている。
--   **経路が1つだけという前提に頼らない**（#99 と同じ考え方）
--
-- ⚠️ **`WHEN NEW.text <> OLD.text` を付ける。** 付けないと、本文を変えていない
-- 更新（完了にする・並び替え）でも関係が消える。
-- SQLite の `UPDATE OF text` は「その列が SET 句に現れたか」しか見ず、
-- **値が実際に変わったかは見ない。** ORM は変えていない列も SET に載せることがある。
CREATE TRIGGER adoptions_drop_on_text_change
AFTER UPDATE OF text ON items
FOR EACH ROW
WHEN NEW.text <> OLD.text
BEGIN
	DELETE FROM adoptions WHERE adopter_item_id = OLD.id;
END;
