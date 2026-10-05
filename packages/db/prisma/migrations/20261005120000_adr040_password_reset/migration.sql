-- ADR-040 -- reset a forgotten password, and change a known one.

-- Three audit actions. ADD VALUE cannot be used in the transaction that adds it, and
-- nothing in this migration does.
ALTER TYPE "AuthEventType" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "AuthEventType" ADD VALUE 'PASSWORD_RESET';
ALTER TYPE "AuthEventType" ADD VALUE 'PASSWORD_CHANGED';

-- The reset link's token, shaped like EmailVerificationToken: the SHA-256 hash only,
-- thirty minutes, consumed once by a conditional update.
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
