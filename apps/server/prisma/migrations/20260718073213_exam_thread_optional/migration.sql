-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "trackSlug" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "result" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startedAt" DATETIME,
    "submittedAt" DATETIME,
    "gradedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Exam_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Exam" ("answers", "config", "createdAt", "gradedAt", "id", "questions", "result", "startedAt", "status", "submittedAt", "threadId", "trackSlug", "userId") SELECT "answers", "config", "createdAt", "gradedAt", "id", "questions", "result", "startedAt", "status", "submittedAt", "threadId", "trackSlug", "userId" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
