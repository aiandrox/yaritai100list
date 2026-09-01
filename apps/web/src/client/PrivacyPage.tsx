import {
  CONTACT_FORM_URL,
  OPERATOR_HANDLE,
  OPERATOR_NAME,
  OPERATOR_URL,
} from '@yaritai100list/shared'

import { LegalHeading, LegalList, LegalPage, LegalRecords, LegalText } from './LegalPage'

/**
 * プライバシーポリシー（#304）。
 *
 * 🔴 **開示している内容は、実装から拾った実際の経路。**
 * 雛形を埋めたものではない。**次を変えたらここも直す。**
 *
 * | 変えたら直すもの | いまの実装 |
 * |---|---|
 * | 判定に AI を使うのをやめた／別のものを足した | `src/pool-judge.ts` |
 * | 画像生成の渡し先を変えた | `src/og.ts` / `src/export-image.ts` |
 * | Sentry に送る内容を増やした | `src/sentry.ts` の `scrubEvent` |
 * | 取得する項目を増やした | `src/db/schema/` |
 *
 * 🔴 **「誰に」はぼかしてよいが、「何が起きるか」はぼかさない**（2026-08-15 の判断）。
 * 委託先の名前は求めに応じて開示する形にしているが、
 * **自動で判定していること**と**第三者の閲覧で本文が外に出ること**は書く。
 */
export function PrivacyPage({ heading }: { heading?: 'h1' | 'h2' | 'none' } = {}) {
  return (
    <LegalPage title="プライバシーポリシー" heading={heading ?? 'h1'}>
      <LegalText>
        「やりたいことリスト100」（以下「本サービス」）における個人情報の取り扱いについて定めます。
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
        ）が個人で運営しています。
      </LegalText>

      <LegalHeading>2. 取得する情報</LegalHeading>
      <LegalRecords
        items={[
          {
            term: 'アカウント情報',
            rows: [
              {
                label: '項目',
                value: 'メールアドレス、表示名、プロフィール画像の URL、メールアドレスの確認状態',
              },
              {
                label: '取得の方法',
                value: 'Google アカウントによるログインの際に、Google から取得します',
              },
            ],
          },
          {
            term: '認証情報',
            rows: [
              { label: '項目', value: '認証に用いるトークン、セッションの識別子' },
              { label: '取得の方法', value: 'ログインの際に生成し、保存します' },
            ],
          },
          {
            term: '投稿内容',
            rows: [
              {
                label: '項目',
                value:
                  'リストのタイトル、やりたいことの本文、メモ、達成日およびその記録の粒度、公開範囲の設定、項目ごとの表示設定',
              },
              { label: '取得の方法', value: '利用者の入力により取得します' },
            ],
          },
          {
            term: '同意の記録',
            rows: [
              { label: '項目', value: '同意した規約の版と、同意した日時' },
              { label: '取得の方法', value: '確認画面で「同意して始める」を押した際に記録します' },
            ],
          },
          {
            term: 'お問い合わせ',
            rows: [
              { label: '項目', value: '種別、内容、返信先として記入された連絡先' },
              { label: '取得の方法', value: 'お問い合わせフォームの送信により取得します' },
            ],
          },
        ]}
      />
      <LegalText>
        クッキーは、ログイン状態の保持にのみ使用します。
        広告の配信およびアクセス解析のための計測は行っていません。
      </LegalText>

      <LegalHeading>3. 利用目的</LegalHeading>
      <LegalList>
        <li>本サービスの提供（リストの保存・表示・共有、画像の生成）</li>
        <li>不具合の把握と対応</li>
        <li>お問い合わせへの回答</li>
      </LegalList>

      <LegalHeading>4. 第三者提供および委託</LegalHeading>
      <LegalText>
        法令に基づく場合を除き、あらかじめ本人の同意を得ることなく、
        個人情報を第三者に提供することはありません。
      </LegalText>
      <LegalText>
        本サービスの提供に必要な範囲で、外国にある事業者に個人情報の取り扱いを委託しています。
        委託の内容は次のとおりです。
      </LegalText>
      <LegalRecords
        items={[
          {
            term: '実行環境およびデータベースの提供',
            rows: [{ label: '対象となる情報', value: '保存しているすべての情報' }],
          },
          {
            term: '公開の可否の判定および表記の統一（自動処理）',
            rows: [
              {
                label: '対象となる情報',
                value: '「全体に公開」に設定されたリストの、やりたいことの本文',
              },
            ],
          },
          {
            term: '画像の生成',
            rows: [{ label: '対象となる情報', value: 'リストのタイトル、やりたいことの本文' }],
          },
          {
            term: '認証',
            rows: [{ label: '対象となる情報', value: 'アカウント情報および認証情報' }],
          },
          {
            term: 'お問い合わせの受付と回答の保管',
            rows: [{ label: '対象となる情報', value: 'お問い合わせの内容' }],
          },
          {
            term: '不具合の把握',
            rows: [
              {
                label: '対象となる情報',
                value: '利用者を識別する ID、エラーが発生したページの URL',
              },
            ],
          },
        ]}
      />
      <LegalText>
        委託先はいずれも米国に所在します。
        <strong className="font-bold text-slate-900">
          委託先の名称、当該国の個人情報の保護に関する制度、および委託先が講じている措置については、
          お問い合わせ窓口までご請求ください。
        </strong>
      </LegalText>
      <LegalList>
        <li>
          <strong className="font-bold text-slate-900">
            公開の可否の判定は自動（AI）で行われます。
          </strong>
          人が内容を読んで判断しているわけではありません。
        </li>
        <li>
          <strong className="font-bold text-slate-900">
            画像の生成は、共有ページが第三者により閲覧された際にも行われます。
          </strong>
          利用者自身が操作していない場合でも、その時点で対象の情報が送信されます。
        </li>
        <li>
          不具合の把握のために送信する情報には、入力された内容・クッキー・通信の内容を含めていません。
        </li>
      </LegalList>

      <LegalHeading>5. 公開される情報</LegalHeading>
      <LegalList>
        <li>
          <strong className="font-bold text-slate-900">
            どの公開面にも、書いた人の名前・メールアドレスは表示しません。
          </strong>
        </li>
        <li>
          「リンクを知っている人だけ」「全体に公開」にしたリストは、URL を知っている人が見られます。
        </li>
        <li>「全体に公開」にしたリストの項目は、作者を伏せた形で「さがす」に並びます。</li>
        <li>
          <strong className="font-bold text-slate-900">メモは、どの公開面にも表示しません。</strong>
          自分だけが読むものとして扱います。
        </li>
      </LegalList>

      <LegalHeading>6. 安全管理措置</LegalHeading>
      <LegalText>
        通信は暗号化しています。データベースへのアクセスは、
        本サービスのプログラムからのみ行える構成としています。
      </LegalText>

      <LegalHeading>7. 保存期間と削除</LegalHeading>
      <LegalList>
        <li>
          アカウントを削除すると、リスト・やりたいこと・メモ・ログイン情報は
          <strong className="font-bold text-slate-900">すべて消えます。</strong>
        </li>
        <li>削除は、ログイン後の「すべてのリスト」からいつでも行えます。</li>
        <li>
          「さがす」のために保持している判定結果のうち、削除後にどこからも参照されなくなったものは、
          あわせて消えます。
        </li>
      </LegalList>

      <LegalHeading>8. 開示・訂正・利用停止の請求</LegalHeading>
      <LegalText>
        保有する個人情報の開示・訂正・削除・利用停止をご希望の場合は、
        <ContactLink />
        からご連絡ください。本人確認のうえ、法令に従って対応します。
      </LegalText>

      <LegalHeading>9. お問い合わせ</LegalHeading>
      <LegalText>
        本ポリシーおよび個人情報の取り扱いに関するお問い合わせは、
        <ContactLink />
        までお願いします。
      </LegalText>

      <LegalHeading>10. 変更</LegalHeading>
      <LegalText>
        必要に応じて本ポリシーを変更することがあります。
        変更後の内容は、このページに掲載した時点から適用されます。
      </LegalText>
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
