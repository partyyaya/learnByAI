CREATE TYPE "ArticleStatus" AS ENUM ('draft', 'published', 'archived');
CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "displayName" TEXT NOT NULL
);
CREATE TABLE "Article" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "authorId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "ArticleStatus" NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Article_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Article_version_positive" CHECK ("version" > 0)
);
CREATE INDEX "Article_status_createdAt_id_idx" ON "Article"("status", "createdAt", "id");
CREATE INDEX "Article_authorId_createdAt_id_idx" ON "Article"("authorId", "createdAt", "id");
