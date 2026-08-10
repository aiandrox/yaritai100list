-- 取り入れ面に出してよいかの判定を貯める（#253 / 親 #252）。
--
-- 🔴 **プールの実体ではない。キャッシュ。**
-- プール（#254）は毎日この表を引いて作り直す。古い行が残っていても害が無い
-- （プールに出ない本文の判定が読まれないだけ）。
--
-- 🔴 **キーは「書かれたままの本文」。正規化した形ではない。**
-- 正規化した形をキーにすると「まだ判定していない本文」を SQL だけで絞れず、
-- **毎回すべての公開項目を JS に読み込んで正規化する**ことになる。
-- 定期実行の CPU は Free で 10ms しかない。
--
-- ⚠️ **`items` への外部キーを張らない。** 項目が消えても判定は残ってよい。
-- 張ると、項目を消すたびに判定を取り直すことになり、AI の呼び出しが無駄に増える。
--
-- ⚠️ **手で書いたマイグレーション**（`--custom`）。
-- drizzle-kit の自動生成は「`adoptions` を `wish_texts` に改名したのか」を対話で聞いてくる。
-- 0010 で `adoptions` を落としたのが custom マイグレーションで、
-- **スナップショットに `adoptions` が残っていた**のが原因。
-- この PR で `meta/0012_snapshot.json` を直してある（`adoptions` を消し、`wish_texts` を足した）。
CREATE TABLE `wish_texts` (
	`raw_text` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`canonical` text,
	`genre` text,
	`checked_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);--> statement-breakpoint
CREATE INDEX `wish_texts_canonical_idx` ON `wish_texts` (`canonical`);
