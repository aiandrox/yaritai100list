import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from './api'
import {
  addItem,
  createEmptyList,
  hasAnythingToImport,
  LIST_STORAGE_KEY,
  moveItem,
  parseStoredList,
  pickCurrentListId,
  removeItem,
  renameList,
  serializeList,
  setItemCompletedAt,
  toImportBody,
  toLocalList,
  updateItemText,
  type Item,
  type ListResult,
  type LocalList,
  type Rejection,
  type SessionState,
} from './model'

/**
 * リストの読み書きの配線。**判定と変換は `model.ts` の純関数に置く**
 * （`TECH_STACK.md` §10）。ここに残すのは通信と localStorage との出入りだけで、
 * このファイルはテストしない。
 *
 * 保存先はログイン状態で変わる（`PRODUCT_SPEC.md` §2）:
 *
 * - 未ログイン: localStorage。1つだけ
 * - ログイン中: サーバー。トップでは**最後に更新したリスト**を開く
 */

/** どこに保存しているか。画面の案内を切り替えるために出す。 */
export type ListSource = 'local' | 'server'

export type ListScreen =
  | { status: 'loading' }
  /** ローカルの保存が読めない。**利用者が了解するまで書き込まない。** */
  | { status: 'broken' }
  /** サーバーから取れなかった。**未ログインと混ぜない**（書いたものを失わせない） */
  | { status: 'failed' }
  /**
   * 表示できる状態。
   *
   * `key` は**どのリストを開いているかの識別子**（ローカルなら `'local'`、
   * サーバーならその `listId`）。画面はこれを React の `key` に使い、
   * **別のリストに切り替わったら入力欄の下書きを作り直す。**
   * 無いと、ログアウトしたのに前のタイトルが入力欄に残る（#102 で踏んだ）。
   */
  | { status: 'ready'; key: string; list: LocalList; source: ListSource }

/**
 * ブラウザの保存を取り込めたか。
 *
 * `limit-reached` のときは**ブラウザ側を消さない。**
 * 整理すれば取り込める、と伝える必要がある（`PRODUCT_SPEC.md` §2）。
 */
export type ImportOutcome = 'none' | 'imported' | 'limit-reached'

/** localStorage が使えるか（プライベートブラウズなどで例外になる）。 */
type LocalStorage = { status: 'ok' } | { status: 'unavailable' } | { status: 'save-failed' }

export interface ListController {
  screen: ListScreen
  storage: LocalStorage
  importOutcome: ImportOutcome
  /** 直前の操作が断られた理由。画面で文言にする */
  rejection: Rejection | null
  startOver: () => void
  renameList: (title: string) => Promise<boolean>
  addItem: (text: string) => Promise<boolean>
  updateItemText: (id: string, text: string) => Promise<boolean>
  toggleItem: (item: Item) => Promise<boolean>
  /** 完了日を直す（#207）。**完了済みの項目にしか使えない** */
  changeCompletedAt: (id: string, completedAt: number) => Promise<boolean>
  removeItem: (id: string) => Promise<boolean>
  /** 1つ分ずらす。`-1` で上、`+1` で下 */
  moveItem: (id: string, toIndex: number) => Promise<boolean>
}

// 断られた理由の型と文言は `model.ts`（取り入れ面からも使うため）
export type { Rejection }

/**
 * @param requestedListId `/lists/:listId` で開いたときのリスト。
 *   `null` なら**最後に更新したリスト**を選ぶ（`PRODUCT_SPEC.md` §4.3）。
 */
export function useList(
  session: SessionState,
  requestedListId: string | null = null,
): ListController {
  const [screen, setScreen] = useState<ListScreen>({ status: 'loading' })
  const [storage, setStorage] = useState<LocalStorage>({ status: 'ok' })
  const [importOutcome, setImportOutcome] = useState<ImportOutcome>('none')
  const [rejection, setRejection] = useState<Rejection | null>(null)

  /** ログイン中に開いているリスト。未ログインなら null */
  const listId = useRef<string | null>(requestedListId)

  /**
   * 取り込みは**一度だけ**走らせる。
   *
   * React は開発時に効果を2回呼ぶ（StrictMode）。守らないと**リストが2つできる。**
   */
  const imported = useRef(false)

  // --- localStorage ---

  const readStored = useCallback(() => {
    try {
      return parseStoredList(window.localStorage.getItem(LIST_STORAGE_KEY))
    } catch {
      return null // localStorage 自体が使えない
    }
  }, [])

  const writeStored = useCallback((list: LocalList) => {
    try {
      window.localStorage.setItem(LIST_STORAGE_KEY, serializeList(list))
      setStorage({ status: 'ok' })
    } catch {
      setStorage({ status: 'save-failed' })
    }
  }, [])

  // --- サーバー ---

  /** ログイン中の表示を作り直す。**取得できなければ `failed`。空リストで塗り潰さない。** */
  const loadFromServer = useCallback(async (): Promise<void> => {
    try {
      if (listId.current === null) {
        const res = await api.api.lists.$get()
        if (!res.ok) {
          setScreen({ status: 'failed' })
          return
        }

        const { lists } = await res.json()
        listId.current = pickCurrentListId(lists)

        // 1つも持っていない人には作る（トップを開いたらすぐ書ける状態にする）
        if (listId.current === null) {
          const created = await api.api.lists.$post({ json: {} })
          if (!created.ok) {
            setScreen({ status: 'failed' })
            return
          }

          const body = await created.json()
          if (!('list' in body)) {
            setScreen({ status: 'failed' })
            return
          }

          listId.current = body.list.id
        }
      }

      const res = await api.api.lists[':listId'].$get({ param: { listId: listId.current } })
      if (!res.ok) {
        // 開いていたリストが消えている場合もここに来る。次は選び直す
        listId.current = null
        setScreen({ status: 'failed' })
        return
      }

      const body = await res.json()
      setScreen({
        status: 'ready',
        key: body.list.id,
        list: toLocalList(body.list, body.items),
        source: 'server',
      })
    } catch {
      setScreen({ status: 'failed' })
    }
  }, [])

  /**
   * ブラウザの保存をサーバーへ取り込む（`PRODUCT_SPEC.md` §2）。
   *
   * 🔴 **取り込めたときだけブラウザ側を消す。** 上限で断られたときに消すと、
   * 書いたものが戻らない。
   */
  const importStored = useCallback(async (): Promise<void> => {
    const stored = readStored()
    if (stored === null || !hasAnythingToImport(stored)) return
    if (stored.status !== 'loaded') return

    const res = await api.api.lists.import.$post({ json: toImportBody(stored.list) })

    if (res.status === 409) {
      setImportOutcome('limit-reached')
      return
    }

    if (!res.ok) return // 取り込めなかった。ブラウザ側は残したまま次の機会に

    // 二重管理を避けるため、取り込めたらブラウザ側は消す
    try {
      window.localStorage.removeItem(LIST_STORAGE_KEY)
    } catch {
      // 消せなくても取り込みは済んでいる。次回はサーバーを見るので実害は無い
    }

    setImportOutcome('imported')
  }, [readStored])

  // --- 起動時 ---

  useEffect(() => {
    if (session.status === 'loading') return

    const start = async () => {
      if (session.status === 'authenticated') {
        // URL で指定されたリストがあればそれを開く。切り替えたときも追随する
        listId.current = requestedListId
        if (!imported.current) {
          imported.current = true
          await importStored()
        }

        await loadFromServer()
        return
      }

      // 未ログイン（`error` のときも書けるようにする。ローカルなら失うものが無い）
      const stored = readStored()

      if (stored === null) {
        setStorage({ status: 'unavailable' })
        setScreen({ status: 'ready', key: 'local', list: createEmptyList(), source: 'local' })
        return
      }

      if (stored.status === 'broken') {
        // **リストを作らない。** 作ると最初の編集で保存を上書きしてしまう
        setScreen({ status: 'broken' })
        return
      }

      setScreen({
        status: 'ready',
        key: 'local',
        list: stored.status === 'loaded' ? stored.list : createEmptyList(),
        source: 'local',
      })
    }

    void start()
  }, [session.status, requestedListId, importStored, loadFromServer, readStored])

  // --- 操作 ---

  /** ローカルの純関数の結果を反映して保存する。 */
  const applyLocal = useCallback(
    (result: ListResult): boolean => {
      if (!result.ok) {
        setRejection(result.reason)
        return false
      }

      setRejection(null)
      setScreen({ status: 'ready', key: 'local', list: result.list, source: 'local' })
      if (storage.status !== 'unavailable') writeStored(result.list)

      return true
    },
    [storage.status, writeStored],
  )

  const onServer = screen.status === 'ready' && screen.source === 'server'
  const list = screen.status === 'ready' ? screen.list : null

  /**
   * **先に画面を変えてから送る。失敗したときだけ取り直して戻す**（#244）。
   *
   * 以前は往復を2回（送る → 取り直す）待ってから画面を変えていたので、
   * **手を離してから反映されるまで、目に見えて間が空いていた。**
   *
   * 手元の純関数（`model.ts`）は**サーバーと同じ結果**を計算できるので、
   * 待つ理由が無い。先に出して、**駄目だったときだけ取り直す。**
   * 並べ替え（#204）が先にこの形になっていて、そちらと揃えた。
   *
   * 🔴 **項目の集合が変わる操作には使えない。**
   * 追加はサーバーが ID を決めるので、手元では正しい状態を作れない
   * （偽の ID を置くと、その行を続けて編集したときに 404 になる）。
   *
   * @param resync 送った後にもう一度取り直す。**サーバーが値を決める操作だけ**
   *   （完了の日時。手元の時計とサーバーの時計は同じとは限らない）。
   *   画面はもう変わっているので、これを待たせても遅さには見えない
   */
  const applyOptimistic = async (
    result: ListResult,
    send: (listId: string) => Promise<{ ok: boolean; status: number }>,
    resync = false,
  ): Promise<boolean> => {
    if (!result.ok) {
      setRejection(result.reason)
      return false
    }

    const id = listId.current
    if (id === null) return false

    setScreen({ status: 'ready', key: id, list: result.list, source: 'server' })

    try {
      const res = await send(id)

      if (!res.ok) {
        setRejection(res.status === 409 ? 'list-full' : 'server-error')
        // 先に画面を変えてあるので、**戻さないとサーバーとずれたままになる**
        await loadFromServer()
        return false
      }

      setRejection(null)
      if (resync) await loadFromServer()

      return true
    } catch {
      setRejection('server-error')
      await loadFromServer()
      return false
    }
  }

  return {
    screen,
    storage,
    importOutcome,
    rejection,

    startOver: () => {
      // ここでは保存を消さない。最初の編集で上書きされる
      setScreen({ status: 'ready', key: 'local', list: createEmptyList(), source: 'local' })
    },

    renameList: async (title) => {
      if (list === null) return false

      return onServer
        ? applyOptimistic(renameList(list, title), (id) =>
            api.api.lists[':listId'].$patch({ param: { listId: id }, json: { title } }),
          )
        : applyLocal(renameList(list, title))
    },

    /**
     * 項目を足す（#244）。**先に行を出す。**
     *
     * 🔴 **ID を決めるのはサーバー**なので、他の操作のようには書けない。
     * 手元では**仮の ID**で行を出し、**応答に入っている本物の ID に差し替える。**
     * 取り直さないのは、`applyOptimistic` と同じ理由（同じものが返るだけ）。
     *
     * ⚠️ **仮の ID のまま編集されると 404 になる。** 窓は往復1回分で、
     * その間カーソルは次の行の入力欄にある（`NextRow`）ので、実際にはまず起きない。
     * 起きたときは失敗として扱われ、取り直して戻る（項目自体は消えない）。
     */
    addItem: async (text) => {
      if (list === null) return false

      const added = addItem(list, { id: crypto.randomUUID(), text })
      if (!added.ok) {
        setRejection(added.reason)
        return false
      }

      if (!onServer) return applyLocal(added)

      const id = listId.current
      if (id === null) return false

      const draftId = added.list.items[added.list.items.length - 1]?.id

      setScreen({ status: 'ready', key: id, list: added.list, source: 'server' })

      try {
        const res = await api.api.lists[':listId'].items.$post({
          param: { listId: id },
          json: { text },
        })

        if (!res.ok) {
          setRejection(res.status === 409 ? 'list-full' : 'server-error')
          await loadFromServer()
          return false
        }

        setRejection(null)

        // 仮の ID を本物に替える。**替え損ねたら取り直す**（ずれたままにしない）
        const body = await res.json()
        if (!('item' in body) || draftId === undefined) {
          await loadFromServer()
          return true
        }

        const realId = body.item.id

        setScreen((current) =>
          current.status === 'ready'
            ? {
                ...current,
                list: {
                  ...current.list,
                  items: current.list.items.map((item) =>
                    item.id === draftId ? { ...item, id: realId } : item,
                  ),
                },
              }
            : current,
        )

        return true
      } catch {
        setRejection('server-error')
        await loadFromServer()
        return false
      }
    },

    updateItemText: async (itemId, text) => {
      if (list === null) return false

      return onServer
        ? applyOptimistic(updateItemText(list, itemId, text), (id) =>
            api.api.lists[':listId'].items[':itemId'].$patch({
              param: { listId: id, itemId },
              json: { text },
            }),
          )
        : applyLocal(updateItemText(list, itemId, text))
    },

    /**
     * 完了にする / 取り消す。
     *
     * 🔴 **完了日時はサーバーが決める**（`src/index.ts` の `updateItemSchema`）。
     * 手元では**その端末の時計**で先に描くので、時計が狂っていると日付がずれて見える。
     * そこで送った後に取り直す（`applyOptimistic` の `resync`）。
     * 画面はもう変わっているので、**取り直しを待っても遅くは見えない。**
     */
    toggleItem: async (item) => {
      if (list === null) return false

      return (
        onServer &&
        applyOptimistic(
          setItemCompletedAt(list, item.id, item.completedAt === null ? Date.now() : null),
          (id) =>
            api.api.lists[':listId'].items[':itemId'].$patch({
              param: { listId: id, itemId: item.id },
              json: { completed: item.completedAt === null },
            }),
          true,
        )
      )
      // 未ログインでは完了にできない（#77）。`onServer` が false なのでここへは来ない
    },

    /**
     * 完了日の直し（#207）。
     *
     * **未ログインでは呼ばれない。** 未ログインでは完了にできないので（#77）、
     * ブラウザ側に完了済みの項目が存在せず、直す対象が無い。
     *
     * 送るのは ISO の日時。**サーバーが未来を弾く**ので、
     * ここで弾けたつもりにならない（画面側の `max` は親切のためだけ）。
     */
    changeCompletedAt: async (itemId, completedAt) => {
      if (list === null) return false

      // ここは**送る値をこちらが決めている**ので、取り直さなくてもずれない。
      // 未来を弾かれたら失敗になり、そのとき取り直して戻る
      return (
        onServer &&
        applyOptimistic(setItemCompletedAt(list, itemId, completedAt), (id) =>
          api.api.lists[':listId'].items[':itemId'].$patch({
            param: { listId: id, itemId },
            json: { completedAt: new Date(completedAt).toISOString() },
          }),
        )
      )
    },

    /**
     * 並べ替え（#142 / #166）。**離したときに1回だけ送る。**
     *
     * 引数は**移動先の位置**（ずらす量ではない）。ドラッグは何行でも飛ぶので、
     * 1つずつずらす形だと途中の並びを何度も送ることになる。
     *
     * 「確定してからまとめて送る」形にはしない。それだと確定を忘れて消える。
     * 他の操作（本文・完了・削除）が全部その場で保存されるので、揃えた。
     * 送る量は**サーバー側で減らしてある**（位置が変わった項目だけ書き直す）。
     *
     * 🔴 **409（項目の集合が違う）なら手元を捨てて取り直す。**
     * 別のタブや端末で足した／消した後なので、こちらの並びを押し通してはいけない。
     */
    moveItem: async (itemId, toIndex) => {
      if (list === null) return false

      const moved = moveItem(list, itemId, toIndex)
      if (!moved.ok) {
        setRejection(moved.reason)
        return false
      }

      if (!onServer) return applyLocal(moved)

      const id = listId.current
      if (id === null) return false

      /**
       * 🔴 **送る前に画面を新しい並びにする**（#204）。
       *
       * 待ってから反映すると、**離した瞬間に一度だけ元の並びに戻って見える。**
       * ドラッグ中の見た目は dnd-kit が作っているもので、離すと消えるため、
       * サーバーの応答が返るまでの間だけ古い並びが出る。
       *
       * 他の操作（本文・完了・削除）は待ってから反映しているが、
       * **並べ替えだけは「動かした」という手応えが要る。**
       * 失敗したときは下で取り直すので、ずれたままにはならない。
       */
      setScreen({ status: 'ready', key: id, list: moved.list, source: 'server' })

      try {
        const res = await api.api.lists[':listId'].items.order.$put({
          param: { listId: id },
          json: { itemIds: moved.list.items.map((item) => item.id) },
        })

        if (res.status === 409) {
          setRejection('order-stale')
          await loadFromServer()
          return false
        }

        if (!res.ok) {
          setRejection('server-error')
          // 先に画面を動かしてあるので、**戻さないとサーバーとずれたままになる**
          await loadFromServer()
          return false
        }

        setRejection(null)

        // 🔴 **取り直さない。** 先に反映した並びと同じものが返るだけで、
        // 往復のぶん画面がもう一度描き直される（そこでまた一瞬ちらつく）。
        // 並べ替えは**項目の集合が変わらない**ので、削除のように詰め直しも要らない
        return true
      } catch {
        setRejection('server-error')
        await loadFromServer()
        return false
      }
    },

    /**
     * 項目を消す。
     *
     * サーバーは消した後に後ろの `position` を詰めるが、**手元の並びは配列の順**で、
     * 詰め直しに相当するものが要らない（`model.ts` の `removeItem`）。
     * だから**取り直さなくてもずれない。**
     */
    removeItem: async (itemId) => {
      if (list === null) return false

      return onServer
        ? applyOptimistic(removeItem(list, itemId), (id) =>
            api.api.lists[':listId'].items[':itemId'].$delete({
              param: { listId: id, itemId },
            }),
          )
        : applyLocal(removeItem(list, itemId))
    },
  }
}
