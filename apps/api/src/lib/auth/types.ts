import type { Locale, UserRole as Role } from "@darkview/contracts";

/**
 * Roles come from contracts/openapi.yaml and are never re-declared here: a second
 * list would be a competing definition of a type that crosses a process boundary,
 * and the two would drift.
 */
export type { Role };

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  locale: Locale;
  createdAt: Date;
};

export type VerifiedSession = {
  id: string;
  user: AuthenticatedUser;
  expiresAt: Date;
  csrfToken: string;
};

export interface SessionProvider {
  getCurrentUser(): Promise<AuthenticatedUser | null>;
}
