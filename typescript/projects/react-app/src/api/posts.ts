import { get } from '@/api/client'
import type { Post } from '@/types'

// 取得所有文章
export function getPosts(): Promise<Post[]> {
  return get<Post[]>('/posts')
}
