CREATE TABLE "OutboxEvent" (
 "id" TEXT PRIMARY KEY, "articleId" TEXT NOT NULL REFERENCES "Article"("id") ON DELETE RESTRICT,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT, "articleVersion" INTEGER NOT NULL CHECK ("articleVersion">0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "enqueuedAt" TIMESTAMPTZ(3),
 "leaseToken" TEXT, "leaseUntil" TIMESTAMPTZ(3), "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts">=0),
 UNIQUE ("articleId","articleVersion")
);
CREATE INDEX "OutboxEvent_enqueuedAt_leaseUntil_createdAt_idx" ON "OutboxEvent"("enqueuedAt","leaseUntil","createdAt");
CREATE TABLE "Notification" (
 "seq" BIGSERIAL PRIMARY KEY, "eventId" TEXT NOT NULL UNIQUE REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT, "articleId" TEXT NOT NULL,
 "articleVersion" INTEGER NOT NULL CHECK ("articleVersion">0), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Notification_userId_seq_idx" ON "Notification"("userId","seq");
