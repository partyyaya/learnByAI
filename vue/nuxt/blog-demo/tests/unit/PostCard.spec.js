// 元件測試：用 mountSuspended 掛在 Nuxt 環境裡（第 15 章）
// mountSuspended 支援 async setup 與自動匯入，NuxtLink 這類內建元件也能正常解析。
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PostCard from '~/components/PostCard.vue'

const post = {
  id: 7,
  title: 'Nuxt 全端開發',
  content: '這是一篇示範文章的內容。',
  published: true,
  createdAt: '2025-03-08T10:20:30.000Z',
  author: { id: 1, name: 'Gary' },
}

describe('PostCard', () => {
  it('顯示標題、摘要與作者', async () => {
    const wrapper = await mountSuspended(PostCard, { props: { post } })

    expect(wrapper.text()).toContain('Nuxt 全端開發')
    expect(wrapper.text()).toContain('這是一篇示範文章的內容。')
    expect(wrapper.text()).toContain('作者：Gary')
  })

  it('連結指向 /posts/:id', async () => {
    const wrapper = await mountSuspended(PostCard, { props: { post } })

    expect(wrapper.get('a').attributes('href')).toBe('/posts/7')
  })

  it('長內容會截成 60 字摘要', async () => {
    const wrapper = await mountSuspended(PostCard, {
      props: { post: { ...post, content: 'a'.repeat(80) } },
    })

    expect(wrapper.get('.excerpt').text()).toBe('a'.repeat(60) + '…')
  })

  it('已發佈的文章不顯示草稿標籤', async () => {
    const wrapper = await mountSuspended(PostCard, { props: { post } })

    expect(wrapper.find('.badge.draft').exists()).toBe(false)
  })

  it('未發佈的文章顯示草稿標籤', async () => {
    const wrapper = await mountSuspended(PostCard, {
      props: { post: { ...post, published: false } },
    })

    expect(wrapper.get('.badge.draft').text()).toBe('草稿')
  })

  it('沒有作者時掛站長', async () => {
    const wrapper = await mountSuspended(PostCard, {
      props: { post: { ...post, author: null } },
    })

    expect(wrapper.text()).toContain('作者：站長')
  })
})
