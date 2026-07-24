import { get } from '@/api/client'
import type { Post, User } from '@/types'

// 取得所有使用者
export function getUsers(): Promise<User[]> {
  return get<User[]>('/users')
}

// 取得單一使用者
export function getUser(id: number): Promise<User> {
  return get<User>(`/users/${id}`)
}

// 取得某位使用者的所有文章
export function getUserPosts(id: number): Promise<Post[]> {
  return get<Post[]>(`/users/${id}/posts`)
}
