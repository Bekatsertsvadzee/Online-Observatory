import "server-only";

import { headers } from "next/headers";

import { getServerEnvironment } from "@/lib/validation/env";

export function isSameOrigin(origin: string | null, appUrl: string) {
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export async function assertSameOrigin() {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const { APP_URL } = getServerEnvironment();

  if (!isSameOrigin(origin, APP_URL)) {
    throw new Error("Cross-origin mutation rejected");
  }
}
