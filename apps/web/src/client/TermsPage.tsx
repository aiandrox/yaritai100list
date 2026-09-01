import {
  CONTACT_FORM_URL,
  OPERATOR_HANDLE,
  OPERATOR_NAME,
  OPERATOR_URL,
} from '@yaritai100list/shared'

import { LegalHeading, LegalList, LegalPage, LegalText } from './LegalPage'

/**
 * 利用規約（#304）。
 *
 * 🔴 **書いてあることは実装と一致していること。**
 * 「取り入れられたものは戻らない」「判定は自動」は、**このアプリが実際にそうなっている**
 * から書いている（`PRODUCT_SPEC.md` §5.4 / #253）。
 * **仕様を変えたらここも直す。**
 *
 * ⚠️ **免責（第7条）は消費者契約法8条に触れる。**
 * 「一切の責任を負わない」と書くと**無効になりうる**ので、
 * 故意・重過失を除く形にしてある。**軽くしようとして書き換えないこと。**
 */
export function TermsPage({ heading }: { heading?: 'h1' | 'h2' | 'none' } = {}) {
  return (
    <LegalPage title="利用規約" heading={heading ?? 'h1'}>
      <LegalText>
        この規約は「やりたいことリスト100」（以下「本サービス」）の利用条件を定めるものです。
        本サービスを利用した時点で、この規約に同意したものとみなします。
      </LegalText>

      <LegalHeading>1. 運営者</LegalHeading>
      <LegalText>
        本サービスは {OPERATOR_NAME}（
        <a
          href={OPERATOR_URL}
          target="_blank"
          rel="noreferrer"
          className="text-brand-deep underline"
        >
          {OPERATOR_HANDLE}
        </a>
        ）が個人で運営しています。無償で提供しています。
      </LegalText>

      <LegalHeading>2. アカウント</LegalHeading>
      <LegalList>
        <li>
          Google アカウントでログインして利用できます。
          <strong className="font-bold text-slate-900">
            ログインしなくても、書くことはできます。
          </strong>
        </li>
        <li>
          アカウントは「すべてのリスト」からいつでも削除できます。削除すると、書いた内容はすべて消え、
          <strong className="font-bold text-slate-900">元に戻せません。</strong>
        </li>
      </LegalList>

      <LegalHeading>3. 投稿内容の扱い</LegalHeading>
      <LegalText>
        この規約において「投稿内容」とは、利用者が本サービスに入力した情報
        （リストのタイトル、やりたいことの本文、メモ、達成日およびその記録の粒度、
        公開範囲の設定、項目ごとの表示設定）をいいます。
      </LegalText>
      <LegalList>
        <li>投稿内容の権利は、書いた本人のものです。運営者はこれを取得しません</li>
        <li>運営者は、本サービスを提供・維持するために必要な範囲で、投稿内容を保存・表示します</li>
        <li>
          公開範囲は利用者が選べます。
          <strong className="font-bold text-slate-900">
            「全体に公開」にしたリストの項目は、作者を伏せた形で「さがす」に並び、
            ほかの利用者が自分のリストに取り入れられます。
          </strong>
        </li>
        <li>
          <strong className="font-bold text-slate-900">
            すでに取り入れられたものは、後から公開範囲を変えても戻りません。
          </strong>
        </li>
      </LegalList>

      <LegalHeading>4. 禁止事項</LegalHeading>
      <LegalText>次の内容を書いたり、送信したりしないでください。</LegalText>
      <LegalList>
        <li>法令に違反するもの、犯罪を助長するもの</li>
        <li>他人の権利（著作権・プライバシー・名誉など）を侵害するもの</li>
        <li>本人の同意なく、特定の個人が分かる情報を含むもの</li>
        <li>差別的なもの、わいせつなもの、他人を著しく不快にさせるもの</li>
        <li>広告・勧誘を目的とするもの</li>
        <li>本サービスの運営を妨げる行為（過度な自動アクセスなど）</li>
      </LegalList>

      <LegalHeading>5. 内容の削除</LegalHeading>
      <LegalText>
        運営者は、前条に反すると判断した内容を、事前の通知なく削除できます。
        繰り返す場合はアカウントの利用を停止できます。
      </LegalText>
      <LegalText>
        <strong className="font-bold text-slate-900">判断の一部は自動（AI）で行っています。</strong>
        「さがす」に出す内容は、掲載してよいかを自動で判定していますが、完全ではありません。
        問題のある内容を見つけた場合は、
        <ContactLink />
        からお知らせください。
      </LegalText>

      <LegalHeading>6. サービスの変更・終了</LegalHeading>
      <LegalText>
        運営者は、本サービスの内容を変更したり、提供を終了したりできます。
        終了する場合は、可能な限り事前にお知らせします。
      </LegalText>
      <LegalText>
        <strong className="font-bold text-slate-900">
          個人が無償で運営しているため、予告なく利用できなくなる可能性があります。
        </strong>
        大切な内容は「書き出す」から手元に保存してください。
      </LegalText>

      <LegalHeading>7. 免責</LegalHeading>
      <LegalList>
        <li>
          運営者は、本サービスが
          <strong className="font-bold text-slate-900">
            常に利用できること、不具合がないこと、利用者の目的に適合すること
          </strong>
          を保証しません
        </li>
        <li>
          本サービスの利用によって生じた損害について、運営者は責任を負いません。
          <strong className="font-bold text-slate-900">
            ただし、運営者に故意または重大な過失がある場合を除きます。
          </strong>
        </li>
        <li>通信の障害や不具合により、投稿内容が失われることがあります</li>
      </LegalList>

      <LegalHeading>8. 規約の変更</LegalHeading>
      <LegalText>
        必要に応じてこの規約を変更することがあります。
        変更後の規約は、このページに掲載した時点から適用されます。
      </LegalText>

      <LegalHeading>9. 準拠法</LegalHeading>
      <LegalText>この規約は日本法に準拠します。</LegalText>
    </LegalPage>
  )
}

/** 問い合わせ窓口。**URL は `service.ts` の1箇所。** */
function ContactLink() {
  return (
    <a
      href={CONTACT_FORM_URL}
      target="_blank"
      rel="noreferrer"
      className="font-bold text-brand-deep underline"
    >
      お問い合わせフォーム
    </a>
  )
}
