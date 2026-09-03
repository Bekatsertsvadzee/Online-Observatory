import { NextResponse } from "next/server";

import type { ApiError, ErrorCode } from "@darkview/contracts";

/**
 * Every failure leaving this API is a contract ApiError. The client renders copy
 * from `code`; `message` is English and for operators and logs.
 *
 * `details` must never carry a secret, a device address or a credential -- the
 * contract says so explicitly, and this is the only place error bodies are built.
 */
export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  const body: ApiError = details ? { code, message, details } : { code, message };
  return NextResponse.json(body, { status });
}

export const unauthenticated = () =>
  apiError(401, "UNAUTHENTICATED", "Authentication required.");

export const forbidden = () =>
  apiError(403, "FORBIDDEN", "This account may not perform that action.");
