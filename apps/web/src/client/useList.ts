import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from './api'
import {
  addItem,
  createEmptyList,
  hasAnythingToImport,
  LIST_STORAGE_KEY,
  parseStoredList,
  pickCurrentListId,
  removeItem,
  renameList,
  serializeList,
  toImportBody,
  toLocalList,
  updateItemText,
  type Item,
  type ListResult,
  type LocalList,
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
  removeItem: (id: string) => Promise<boolean>
}

/**
 * 断られた理由。**ローカルの検証結果とサーバーの応答を同じ形にまとめる。**
 * 画面はどちらに保存しているかを気にせず文言を出せる。
 */
export type Rejection = Extract<ListResult, { ok: false }>['reason'] | 'server-error'

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

  /**
   * サーバーへの1操作。**成功したら取り直す。**
   *
   * 削除で後ろの並び順が詰まるなど、応答だけでは画面を正しく作れない場合がある。
   * 往復は増えるが、**表示が DB とずれない**ことを優先する。
   */
  const applyServer = useCallback(
    // Hono RPC が返すのは `Response` そのものではないので、見たい2つだけを型にする
    async (
      send: (listId: string) => Promise<{ ok: boolean; status: number }>,
    ): Promise<boolean> => {
      const id = listId.current
      if (id === null) return false

      try {
        const res = await send(id)

        if (!res.ok) {
          setRejection(res.status === 409 ? 'list-full' : 'server-error')
          return false
        }

        setRejection(null)
        await loadFromServer()

        return true
      } catch {
        setRejection('server-error')
        return false
      }
    },
    [loadFromServer],
  )

  const onServer = screen.status === 'ready' && screen.source === 'server'
  const list = screen.status === 'ready' ? screen.list : null

  return {
    screen,
    storage,
    importOutcome,
    rejection,

    startOver: () => {
      // ここでは保存を消さない。最初の編集で上書きされる
      setScreen({ status: 'ready', key: 'local', list: createEmptyList(), source: 'local' })
    },

    renameList: async (title) =>
      onServer
        ? applyServer((id) =>
            api.api.lists[':listId'].$patch({ param: { listId: id }, json: { title } }),
          )
        : list !== null && applyLocal(renameList(list, title)),

    addItem: async (text) =>
      onServer
        ? applyServer((id) =>
            api.api.lists[':listId'].items.$post({ param: { listId: id }, json: { text } }),
          )
        : list !== null && applyLocal(addItem(list, { id: crypto.randomUUID(), text })),

    updateItemText: async (itemId, text) =>
      onServer
        ? applyServer((id) =>
            api.api.lists[':listId'].items[':itemId'].$patch({
              param: { listId: id, itemId },
              json: { text },
            }),
          )
        : list !== null && applyLocal(updateItemText(list, itemId, text)),

    toggleItem: async (item) =>
      onServer
        ? applyServer((id) =>
            api.api.lists[':listId'].items[':itemId'].$patch({
              param: { listId: id, itemId: item.id },
              json: { completed: item.completedAt === null },
            }),
          )
        : // 未ログインでは完了にできない（#77）。ここへは来ない
          false,

    removeItem: async (itemId) =>
      onServer
        ? applyServer((id) =>
            api.api.lists[':listId'].items[':itemId'].$delete({
              param: { listId: id, itemId },
            }),
          )
        : list !== null && applyLocal(removeItem(list, itemId)),
  }
}
