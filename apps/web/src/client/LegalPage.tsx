import { formatLegalDate, LEGAL_EFFECTIVE_DATE } from '@yaritai100list/shared'

/**
 * 利用規約とプライバシーポリシーの枠（#304）。
 *
 * 🔴 **見た目を1箇所にまとめる。** 2つの長い文書を別々に組むと、
 * 見出しの大きさや行間がすぐにずれる（`Modal.tsx` を切り出したのと同じ理由）。
 *
 * ⚠️ **ここは読ませる文書。** 画面の他の場所より**行間を広く**取っている。
 * 100行の一覧とは目的が違う。
 */

/** 見出し。**節ごとに番号を振る**（「第4条の話」と指せるようにするため）。 */
export function LegalHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-base font-bold text-slate-900">{children}</h2>
}

/** 本文。 */
export function LegalText({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm leading-7 text-slate-700">{children}</p>
}

/** 箇条書き。 */
export function LegalList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-7 text-slate-700">{children}</ul>
  )
}

/**
 * 「何が」「どこへ」を並べるところ（#304）。
 *
 * 🔴 **表にしない。** 3列の表は**電話の幅に収まらず、横スクロールになる。**
 * 読ませる文書で横に流すのは筋が悪い（主対象はモバイル縦1カラム。`PRODUCT_SPEC.md` §4.5）。
 * **1件ずつ縦に積む。**
 *
 * ⚠️ 広い画面では余白が増えるが、**読みにくくはならない。**
 */
export function LegalRecords({
  items,
}: {
  items: { term: string; rows: { label: string; value: string }[] }[]
}) {
  return (
    <div className="mt-3 space-y-3">
      {items.map((item) => (
        <div key={item.term} className="rounded bg-white px-3 py-3">
          <p className="text-sm font-bold text-slate-900">{item.term}</p>

          <dl className="mt-1 space-y-1">
            {item.rows.map((row) => (
              <div key={row.label} className="text-xs leading-6 text-slate-700">
                <dt className="inline font-bold">{row.label}: </dt>
                <dd className="inline">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-8">
      <h1 className="text-xl font-bold text-slate-900">{title}</h1>

      {children}

      {/* 🔴 **いつからのものかを出す。**「掲載した時点から適用する」と書く以上、必須 */}
      <p className="mt-10 text-xs text-slate-500">
        制定日: {formatLegalDate(LEGAL_EFFECTIVE_DATE)}
      </p>
    </div>
  )
}
