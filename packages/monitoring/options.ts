import { scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * ADR-064 §2: the SDK options, or null when `SENTRY_DSN` is unset and nothing may
 * be sent. Errors only: no tracing, no profiling, no default PII.
 */
export function monitoringOptions(environment: Partial<Record<string, string>>) {
  const dsn = environment.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment:
      environment.SENTRY_ENVIRONMENT?.trim() ||
      environment.DARKVIEW_DEPLOYMENT ||
      environment.NODE_ENV ||
      "development",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: <T extends object>(event: T) => scrubEvent(event),
    beforeBreadcrumb: <T extends object>(breadcrumb: T) => scrubBreadcrumb(breadcrumb),
  };
}
