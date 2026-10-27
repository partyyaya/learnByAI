export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function validateDraft(value: unknown): { title: string; content: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'body 必須是物件');
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => key !== 'title' && key !== 'content')) {
    throw new HttpError(400, 'VALIDATION_ERROR', '只接受 title 與 content');
  }
  if (typeof object.title !== 'string' || typeof object.content !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'title 與 content 必須是字串');
  }
  const title = object.title.trim();
  const content = object.content.trim();
  if (!title || !content || [...title].length > 120 || [...content].length > 4000) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'title 為 1–120、content 為 1–4000 個 Unicode code point');
  }
  return { title, content };
}
