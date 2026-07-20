import { PrismaClient } from '@prisma/client'

// PrismaClient 單例：開發時 HMR 會重載模組，用 globalThis 快取避免重複連線。
// server/utils/ 底下的匯出會自動匯入到所有 server 檔案，直接用 `prisma` 即可。
const globalForPrisma = globalThis

export const prisma = globalForPrisma.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
