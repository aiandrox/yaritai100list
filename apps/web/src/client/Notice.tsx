/**
 * 画面の上に出す短い案内。**色の値はここにも書かない**（`index.css` の `@theme`）。
 *
 * `warn` は「このままだと困ることが起きる」ときだけに使う。
 * 何にでも付けると、本当に困るときに目立たなくなる。
 */
export function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  return (
    <p
      className={`mb-3 rounded px-3 py-2 text-xs ${
        tone === 'warn' ? 'bg-white text-brand-deep' : 'bg-white/70 text-slate-600'
      }`}
    >
      {children}
    </p>
  )
}
