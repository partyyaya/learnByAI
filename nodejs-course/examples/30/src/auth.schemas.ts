import { z } from 'zod';
const email = z.string().trim().toLowerCase().email().max(254);
// 密碼不 trim、不 normalize；接受長 passphrase，限制成本與 bytes，沒有字元種類組合規則。
const password = z.string().refine(value => [...value].length >= 15 && [...value].length <= 128 && Buffer.byteLength(value) <= 512);
export const loginSchema = z.strictObject({ email, password });
export const registerSchema = z.strictObject({ email, password, displayName: z.string().trim().refine(value => [...value].length >= 1 && [...value].length <= 80) });
export const logoutSchema = z.strictObject({});
export type LoginDto = z.output<typeof loginSchema>;
export type RegisterDto = z.output<typeof registerSchema>;
