import type { MigrationInterface,QueryRunner } from 'typeorm';
// SQL is reviewed explicitly; synchronize stays disabled.
const createSql=`CREATE TYPE "ArticleStatus" AS ENUM ('draft', 'published', 'archived');
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

CREATE TYPE "UserRole" AS ENUM ('member', 'admin');
ALTER TABLE "User" ADD COLUMN "email" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'member';
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "Session" (
  "tokenHash" CHAR(64) NOT NULL,
  "csrfToken" VARCHAR(43) NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

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

CREATE TABLE "Comment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "articleId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Comment_content_length" CHECK (char_length("content") BETWEEN 1 AND 1000),
  CONSTRAINT "Comment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Comment_articleId_createdAt_id_idx" ON "Comment"("articleId", "createdAt", "id");
`;
export class CourseSchema1793664000000 implements MigrationInterface {
 name='CourseSchema1793664000000';
 async up(queryRunner:QueryRunner){const schema=String((queryRunner.connection.options as {schema?:string}).schema??'public');if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('invalid schema');await queryRunner.query(`SET LOCAL search_path TO "${schema}"`);await queryRunner.query(createSql);}
 async down(queryRunner:QueryRunner){
  const schema=String((queryRunner.connection.options as {schema?:string}).schema??'public');
  if(!/^orm34_[a-f0-9]{32}$/.test(schema))throw new Error('revert is restricted to owned test schemas');
  for(const table of ['Comment','ArticleStatusAudit','Session','Article','User']){const rows=await queryRunner.query(`SELECT count(*)::integer AS count FROM "${schema}"."${table}"`);if(rows[0].count!==0)throw new Error('refuse to revert nonempty schema');}
  await queryRunner.query(`SET LOCAL search_path TO "${schema}"`);
  for(const table of ['Comment','ArticleStatusAudit','Session','Article','User'])await queryRunner.query(`DROP TABLE "${table}"`);
  for(const type of ['ArticleStatusAction','UserRole','ArticleStatus'])await queryRunner.query(`DROP TYPE "${type}"`);
 }
}
