-- 取り入れ面に出す一覧（#254 / 親 #252）。
--
-- 🔴 **派生データ。** バッチ（`src/pool.ts` の `rebuildPool`）が総入れ替えする。
-- 中身が空でも壊れていない（次のバッチで戻る）。移行のために埋める必要は無い。
--
-- ⚠️ **デプロイ直後は空になる。** バッチ（1時間ごと）が1回動くまで取り入れ面に何も出ない。
-- 日次にしていないのはこれが理由の1つ（`src/index.ts` の `runPoolBatch`）。
CREATE TABLE `pool` (
	`canonical` text PRIMARY KEY NOT NULL,
	`genre` text NOT NULL,
	`writers` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_writers_idx` ON `pool` (`writers`);--> statement-breakpoint
-- 判定に使ったモデルを記録する（#254）。
--
-- 🔴 **モデルを変えたときに `wish_texts` を消さずに済ませるための列。**
-- 消すとプールが空になり、戻るのに何日もかかる（判定は1日 360 件しか進まない）。
ALTER TABLE `wish_texts` ADD `model` text;--> statement-breakpoint
-- 🔴 **既にある行を「今のモデルで判定済み」にする。**
-- ここで埋めないと、#253 が入れた行が全部「古い判定」に見え、
-- **同じ答えを得るためだけに AI を呼び直す**（無料枠を無駄に焼く）。
-- 値は `src/pool-judge.ts` の `POOL_JUDGE_MODEL`。**この行を後から書き換えないこと**
-- （モデルを変えるときは定数だけを変える。既存の行は古い判定として拾い直される）。
UPDATE `wish_texts` SET `model` = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' WHERE `model` IS NULL;
