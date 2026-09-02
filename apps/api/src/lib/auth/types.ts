export const roles = ["USER", "OPERATOR", "ADMIN"] as const;

export type Role = (typeof roles)[number];

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
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
