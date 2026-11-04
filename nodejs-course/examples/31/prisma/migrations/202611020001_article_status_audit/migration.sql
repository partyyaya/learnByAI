CREATE TYPE "ArticleStatusAction" AS ENUM ('publish', 'archive');

CREATE TABLE "ArticleStatusAudit" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "ArticleStatusAction" NOT NULL,
    "fromStatus" "ArticleStatus" NOT NULL,
    "toStatus" "ArticleStatus" NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArticleStatusAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArticleStatusAudit_version_check" CHECK (
        "fromVersion" > 0 AND "toVersion"::BIGINT = "fromVersion"::BIGINT + 1
    ),
    CONSTRAINT "ArticleStatusAudit_transition_check" CHECK (
        ("action" = 'publish' AND "fromStatus" = 'draft' AND "toStatus" = 'published') OR
        ("action" = 'archive' AND "fromStatus" IN ('draft', 'published') AND "toStatus" = 'archived')
    )
);

CREATE UNIQUE INDEX "ArticleStatusAudit_articleId_toVersion_key" ON "ArticleStatusAudit"("articleId", "toVersion");
CREATE INDEX "ArticleStatusAudit_actorId_createdAt_idx" ON "ArticleStatusAudit"("actorId", "createdAt");
ALTER TABLE "ArticleStatusAudit" ADD CONSTRAINT "ArticleStatusAudit_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArticleStatusAudit" ADD CONSTRAINT "ArticleStatusAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
