import type { User } from "@darkview/contracts";

import type { AuthenticatedUser } from "@/lib/auth/types";

/**
 * The stored user projected into the contract's User.
 *
 * Only what the contract declares crosses the boundary. The row also holds
 * emailVerifiedAt, isDemo and the session relations; none of those are the
 * client's business, and `additionalProperties: false` on the contract schema
 * means sending them would be a contract violation, not merely untidy.
 *
 * `name` is stored non-null; the contract models displayName as nullable because
 * a user may not have set one.
 */
export function toContractUser(user: AuthenticatedUser): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.name || null,
    role: user.role,
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
  };
}
