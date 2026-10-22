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
  /** Empty for a bearer session, which has no CSRF cookie (ADR-061). */
  csrfToken: string;
  /** How the request proved it: the web client's cookies, or a native bearer token. */
  credential: "cookie" | "bearer";
};

export interface SessionProvider {
  getCurrentUser(): Promise<AuthenticatedUser | null>;
}
