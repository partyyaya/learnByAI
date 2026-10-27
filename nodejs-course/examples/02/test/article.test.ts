import { describe, expect, test } from '@jest/globals';
import { publishArticle } from '../src/article.js';
import type { Article } from '../src/article.js';

function makeDraft(): Article {
  return {
    id: 'a_1001',
    authorId: 'u_alice',
    title: '第一篇文章',
    content: '文章內容',
    status: 'draft',
    version: 3,
  };
}

describe('發佈文章', () => {
  test('草稿發佈後保留內容、變更狀態並增加版本', () => {
    const draft = makeDraft();

    const result = publishArticle(draft);

    expect(result).toEqual({ ...draft, status: 'published', version: 4 });
  });

  test('不修改呼叫端持有的原始文章', () => {
    const draft = makeDraft();
    const before = { ...draft };

    const result = publishArticle(draft);

    expect(draft).toEqual(before);
    expect(result).not.toBe(draft);
  });

  test.each(['published', 'archived'] as const)('%s 文章不能再發佈', (status) => {
    const article = { ...makeDraft(), status };
    const before = { ...article };

    expect(() => publishArticle(article)).toThrow('INVALID_ARTICLE_STATE');
    expect(article).toEqual(before);
  });
});
