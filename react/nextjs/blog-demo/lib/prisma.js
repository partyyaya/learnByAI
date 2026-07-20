// 全專案共用同一個 Prisma Client。
// 開發時 Next.js 熱更新會重載模組，用 globalThis 快取避免開太多連線（第 9 章）。
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
