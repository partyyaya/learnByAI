import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

interface FavoritesState {
  ids: number[]
  toggle: (id: number) => void
  isFavorite: (id: number) => boolean
  clear: () => void
}

// 包一層「不會丟例外」的 storage：私密瀏覽模式、儲存空間爆滿等情況下
// localStorage 的方法可能直接 throw，若不接住會讓 persist middleware 整個掛掉。
// 讀取失敗就當作沒有資料（回傳 null）、寫入/刪除失敗就靜默略過。
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
    } catch {
      // 寫入失敗就先略過，記憶體內的收藏狀態仍維持正確
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // 忽略
    }
  },
}

// 收藏清單：透過 persist middleware 自動同步到 localStorage
// 注意型別參數的寫法，讓 persist 能正確推論 state 型別
export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],

      toggle(id: number) {
        const { ids } = get()
        set({
          ids: ids.includes(id)
            ? ids.filter((favId) => favId !== id)
            : [...ids, id],
        })
      },

      isFavorite(id: number) {
        return get().ids.includes(id)
      },

      clear() {
        set({ ids: [] })
      },
    }),
    {
      name: 'favorites', // localStorage 的 key
      storage: createJSONStorage(() => safeStorage),
    },
  ),
)
