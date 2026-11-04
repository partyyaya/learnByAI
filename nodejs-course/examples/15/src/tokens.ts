// Symbol 的說明文字供除錯；身分來自這個匯出的 Symbol 值，不能在使用端重建。
export const DATABASE_INPUT = Symbol('DATABASE_INPUT');
export const DATABASE = Symbol('DATABASE');
export const ARTICLE_REPOSITORY = Symbol('ARTICLE_REPOSITORY');
export const ARTICLE_SERVICE = Symbol('ARTICLE_SERVICE');
export const CHECK_READY = Symbol('CHECK_READY');
export const REQUEST_LIFECYCLE = Symbol('REQUEST_LIFECYCLE');

export type ReadinessCheck = () => Promise<void>;
