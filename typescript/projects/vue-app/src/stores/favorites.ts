import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'

const STORAGE_KEY = 'favorite-user-ids'

// 從 localStorage 讀取初始的收藏清單；解析失敗時回傳空陣列。
function loadInitial(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === 'number')
      : []
  } catch {
    return []
  }
}

// 收藏使用者的 store：只存 user id 陣列，並手動同步到 localStorage。
export const useFavoritesStore = defineStore('favorites', () => {
  const ids = ref<number[]>(loadInitial())

  const count = computed(() => ids.value.length)

  function isFavorite(id: number): boolean {
    return ids.value.includes(id)
  }

  function toggle(id: number): void {
    if (isFavorite(id)) {
      ids.value = ids.value.filter((x) => x !== id)
    } else {
      ids.value.push(id)
    }
  }

  function clear(): void {
    ids.value = []
  }

  // 監看 ids 變化，寫回 localStorage（deep 以便捕捉 push 造成的變動）。
  // 加 try/catch：儲存空間爆滿、被封鎖等情況下 setItem 可能丟例外，
  // 若不接住，記憶體內的收藏狀態仍會正確更新，只是「這次沒能存下來」，
  // 不該讓一次寫入失敗變成未捕捉的例外。
  watch(
    ids,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // 寫入失敗就先略過，畫面上的收藏狀態仍維持正確
      }
    },
    { deep: true },
  )

  return { ids, count, isFavorite, toggle, clear }
})
