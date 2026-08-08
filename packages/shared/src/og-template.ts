import type { OgPayload } from './og'
import { SERVICE_NAME } from './service'

/**
 * OGP 画像のレイアウト（#172）。
 *
 * 🔴 **Satori に渡すのはただのオブジェクト**なので、組み立ては純関数にできる。
 * `packages/shared` に置いてあるのは3つの理由:
 *
 * - **workerd のテストでレイアウトを固定できる**（Deno 側にテストランナーを増やさない）
 * - Deno 側が「受け取る → Satori → resvg → PNG」だけの薄い層になる
 * - #9（ダウンロード画像）でも同じ置き場所を使える
 *
 * ⚠️ **Satori を依存に入れない。** 型だけ自前で持つ。
 * shared が重くなると Worker のバンドル（3MB の上限）にも効く。
 *
 * ⚠️ **flexbox のサブセットしか使えない**（`TECH_STACK.md` §4.3）。
 * `grid` は動かない。`display: flex` を明示しないと落ちることがある。
 */

/** Satori が受け取る要素。**React に依存しない形**で書く。 */
export interface OgElement {
  type: string
  props: {
    style?: Record<string, string | number>
    children?: OgElement | OgElement[] | string
  }
}

/** 画像の大きさ。SNS のカードで一般的な 1.91:1（`PRODUCT_SPEC.md` §5.3 で言及）。 */
export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

/**
 * 色。**`tokens.css` と同じ値**（`src/tokens.css`。#159）。
 *
 * ⚠️ ここは CSS を読めない（Satori に渡すのは JS のオブジェクト）ので、
 * **3箇所目の定義になっている。** 変えるときは `tokens.css` も見ること。
 */
const COLORS = {
  brand: '#ffa2ab',
  brandSoft: '#fff5f6',
  brandDeep: '#b34452',
  ink: '#0f172a',
  muted: '#64748b',
} as const

function text(value: string, style: Record<string, string | number>): OgElement {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: value } }
}

/**
 * カードを組み立てる。
 *
 * 載せるのは**タイトルと達成状況だけ**（`PRODUCT_SPEC.md` §5.2）。
 * 項目の一覧は載せない（あれは画像出力 #9 の役割）。
 * **作者は載せない**（そもそも `OgPayload` に入っていない）。
 */
export function buildOgTemplate(payload: OgPayload): OgElement {
  const ratio = payload.filled === 0 ? 0 : payload.completed / payload.filled

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: '64px 72px',
        backgroundColor: COLORS.brandSoft,
        // フォント名は Deno 側が読み込むときの名前と合わせる
        fontFamily: 'Noto Sans JP',
        color: COLORS.ink,
      },
      children: [
        text(SERVICE_NAME, { fontSize: 28, color: COLORS.brandDeep, fontWeight: 700 }),

        // タイトル。**長いときは折り返す**（30文字まで。#146）
        text(payload.title, { fontSize: 84, fontWeight: 700, lineHeight: 1.25 }),

        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: '20px' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', alignItems: 'baseline', gap: '12px' },
                  children: [
                    text(String(payload.completed), {
                      fontSize: 72,
                      fontWeight: 700,
                      color: COLORS.brandDeep,
                    }),
                    text(`/ ${String(payload.filled)}`, { fontSize: 36, color: COLORS.muted }),
                    text('やった', { fontSize: 28, color: COLORS.muted }),
                  ],
                },
              },

              // 進み具合の帯。**数字と同じことを別の形で見せる**（一目で分かるように）
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '100%',
                    height: '16px',
                    borderRadius: '8px',
                    backgroundColor: COLORS.brand,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          width: `${String(Math.round(ratio * 100))}%`,
                          height: '100%',
                          borderRadius: '8px',
                          backgroundColor: COLORS.brandDeep,
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  }
}
