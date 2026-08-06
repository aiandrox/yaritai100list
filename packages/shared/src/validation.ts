import { z } from 'zod'

import { ITEM_TEXT_MAX_LENGTH, LIST_TITLE_MAX_LENGTH } from './limits'

/**
 * リストの公開範囲。`PRODUCT_SPEC.md` §5.1。
 *
 * - `private`: 自分だけ。**既定値**
 * - `unlisted`: URL を知っている人だけ（リンク限定公開）
 * - `public`: URL を知っている人だけ + **項目が取り入れ面のプールに入る**
 *
 * `unlisted` と `public` でリストの見え方は同じ。違いは項目をプールに提供するかだけ。
 *
 * この配列を唯一の情報源にして、Zod スキーマと D1 の CHECK 制約の両方を作る。
 */
export const VISIBILITIES = ['private', 'unlisted', 'public'] as const

export type Visibility = (typeof VISIBILITIES)[number]

export const visibilitySchema = z.enum(VISIBILITIES)

/**
 * 文字数は **UTF-16 のコード単位**で数える（`String.prototype.length`）。
 *
 * 見た目の文字数（書記素）で数える方が利用者の直感には近いが、
 * ここでの上限は**画像出力のレイアウト崩れと CPU 消費を防ぐための箍**なので、
 * 文字列の長さを確実に押さえられる方を採る。
 * 書記素で数えると、絵文字の連結（👨‍👩‍👧‍👦 は1書記素で11コード単位）を並べられてしまい、
 * 箍として機能しない。
 */
export const listTitleSchema = z.string().trim().min(1).max(LIST_TITLE_MAX_LENGTH)

export const itemTextSchema = z.string().trim().min(1).max(ITEM_TEXT_MAX_LENGTH)
