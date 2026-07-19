-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "intent" TEXT;
ALTER TABLE "Thread" ADD COLUMN "roadmapDay" INTEGER;

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goalType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intake',
    "intake" JSONB NOT NULL,
    "accent" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Track_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Track_userId_lastActiveAt_idx" ON "Track"("userId", "lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "Track_userId_slug_key" ON "Track"("userId", "slug");
