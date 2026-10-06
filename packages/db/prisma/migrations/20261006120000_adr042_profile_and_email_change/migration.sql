-- ADR-042 -- edit the profile, and change the email address.

-- Three audit actions. ADD VALUE cannot be used in the transaction that adds it, and
-- nothing in this migration does.
ALTER TYPE "AuthEventType" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "AuthEventType" ADD VALUE 'EMAIL_CHANGE_REQUESTED';
ALTER TYPE "AuthEventType" ADD VALUE 'EMAIL_CHANGED';

-- The change link's token, shaped like PasswordResetToken, plus the address the account
-- moves to when the link is followed.
CREATE TABLE "EmailChangeToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "newEmail" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailChangeToken_tokenHash_key" ON "EmailChangeToken"("tokenHash");
CREATE INDEX "EmailChangeToken_userId_idx" ON "EmailChangeToken"("userId");
CREATE INDEX "EmailChangeToken_expiresAt_idx" ON "EmailChangeToken"("expiresAt");

ALTER TABLE "EmailChangeToken" ADD CONSTRAINT "EmailChangeToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
