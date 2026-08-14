-- 完了日の粒度（#279）。「やったことは記録したいが、日付を覚えていない」に対応する。
--
-- 🔴 **これ以降、完了かどうかは `completed_precision` で判定する。**
-- `completed_at` は「日付を覚えている完了」しか持たない
-- （粒度 `unknown` の完了は NULL のまま）。
ALTER TABLE `items` ADD `completed_precision` text;--> statement-breakpoint

-- 既にある完了は**日まで覚えている**扱いにする。
-- #279 より前は「日時が入っている = 完了」しか作れなかったので、これで意味が変わらない。
UPDATE `items` SET `completed_precision` = 'day' WHERE `completed_at` IS NOT NULL;--> statement-breakpoint

-- 粒度と完了日時の組み合わせを **DB でも** 止める（`TECH_STACK.md` §7）。
--
-- ⚠️ **CHECK 制約では書けない。** SQLite は既存の表に CHECK を後から足せず、
-- 表の作り直し（作成 → 移送 → 差し替え）が要る。`items` は外部キーと索引を持つので、
-- リスクの割に得るものが小さい。`lists` の件数上限（`0006`）と同じ理由でトリガーにする。
--
-- 🔴 **粒度の値そのものもここで縛っている**（`IN` の列挙）。
-- 値を増やすときは `packages/shared` の `COMPLETED_PRECISIONS` とここの両方を変える。
-- 一致することはテスト（`test/items.test.ts`）で固定してある。
-- 🔴 **`OR` を並べる形では書けない。** SQL の比較は3値論理なので、
-- `completed_precision` が NULL のとき `= 'unknown'` も `IN (...)` も**NULL になり、
-- 条件全体が NULL（真でも偽でもない）になってトリガーが発火しない。**
-- 実際にこれで「未完了なのに完了日時がある行」が入った（テストで捕まえた）。
-- **`CASE` で粒度ごとに分け、NULL を最初に受ける。**
CREATE TRIGGER items_completed_precision_on_insert
BEFORE INSERT ON items
FOR EACH ROW
WHEN NOT (
  CASE
    -- 未完了: どちらも持たない
    WHEN NEW.completed_precision IS NULL THEN NEW.completed_at IS NULL
    -- 日付なしの完了: 粒度だけ持つ
    WHEN NEW.completed_precision = 'unknown' THEN NEW.completed_at IS NULL
    -- 日付のある完了: 日時が必須
    WHEN NEW.completed_precision IN ('day', 'month', 'year') THEN NEW.completed_at IS NOT NULL
    -- 知らない粒度は入れない
    ELSE 0
  END
)
BEGIN
	SELECT RAISE(ABORT, 'invalid completed_precision');
END;--> statement-breakpoint

-- 更新でも同じ形を保つ。**経路が1つだけという前提に頼らない**（`0006` と同じ）
CREATE TRIGGER items_completed_precision_on_update
BEFORE UPDATE OF completed_precision, completed_at ON items
FOR EACH ROW
WHEN NOT (
  CASE
    WHEN NEW.completed_precision IS NULL THEN NEW.completed_at IS NULL
    WHEN NEW.completed_precision = 'unknown' THEN NEW.completed_at IS NULL
    WHEN NEW.completed_precision IN ('day', 'month', 'year') THEN NEW.completed_at IS NOT NULL
    ELSE 0
  END
)
BEGIN
	SELECT RAISE(ABORT, 'invalid completed_precision');
END;
