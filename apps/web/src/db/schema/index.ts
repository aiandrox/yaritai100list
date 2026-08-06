/**
 * テーブル定義の入口。**DB に触るのはこの層だけ**（`CLAUDE.md` の不変条件）。
 *
 * ファイルを増やしたらここに足す。`drizzle.config.ts` は
 * `./src/db/schema/*.ts` を見るので、置き忘れてもマイグレーションには入るが、
 * アプリ側から import できなくなる。
 */
export * from './auth'
export * from './lists'
