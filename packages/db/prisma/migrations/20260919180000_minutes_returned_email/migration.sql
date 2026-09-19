-- Issue #123: a refund that returns subscription minutes tells the customer so, in
-- its own email. BOOKING_REFUNDED states an amount of money, and none moved.

ALTER TYPE "EmailNotificationKind" ADD VALUE 'SUBSCRIPTION_MINUTES_RETURNED';
