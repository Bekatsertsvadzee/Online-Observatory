/**
 * ADR-064 §3: what never leaves a process in an error report.
 *
 * Written against the shape of a Sentry event, not its types, so this package
 * depends on no SDK and the same function serves the API and realtime.
 */

export const SCRUBBED = "[scrubbed]";

/** A key whose value is a credential, a code or personal data. */
const SECRET_KEY =
  /token|password|passwd|secret|key|code|signature|session|cookie|authorization|email|phone/i;

const SECRET_PAIR =
  /\b([\w-]*(?:token|password|passwd|secret|key|code|signature|session|cookie|authorization)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /[A-Za-z0-9+_-]{40,}={0,2}/g,
];

export function scrubText(text: string): string {
  // The bearer value first: "Authorization: Bearer x" would otherwise lose only "Bearer".
  let out = text
    .replace(BEARER, SCRUBBED)
    .replace(
      SECRET_PAIR,
      (_match, key: string, separator: string) => `${key}${separator}${SCRUBBED}`,
    );
  for (const pattern of PATTERNS) out = out.replace(pattern, SCRUBBED);
  return out;
}

/** A URL without its query string or fragment: both carry codes and tokens. */
export function scrubUrl(url: string): string {
  const end = url.search(/[?#]/);
  return scrubText(end === -1 ? url : url.slice(0, end));
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return SCRUBBED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? SCRUBBED : scrubValue(item, depth + 1),
    ]),
  );
}

type Breadcrumb = { message?: string; data?: Record<string, unknown> };

type EventLike = {
  message?: string;
  user?: unknown;
  request?: { url?: string; method?: string; headers?: Record<string, string> } & Record<
    string,
    unknown
  >;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: Breadcrumb[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  server_name?: string;
};

export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
  const crumb = breadcrumb as Breadcrumb;
  if (crumb.message) crumb.message = scrubText(crumb.message);
  if (crumb.data) {
    const data = scrubValue(crumb.data) as Record<string, unknown>;
    for (const field of ["url", "to", "from"]) {
      if (typeof data[field] === "string") data[field] = scrubUrl(data[field] as string);
    }
    crumb.data = data;
  }
  return breadcrumb;
}

export function scrubEvent<T extends object>(event: T): T {
  const report = event as EventLike;
  delete report.user;
  delete report.server_name;
  if (report.request) {
    const userAgent =
      report.request.headers?.["user-agent"] ?? report.request.headers?.["User-Agent"];
    report.request = {
      ...(report.request.url ? { url: scrubUrl(report.request.url) } : {}),
      ...(report.request.method ? { method: report.request.method } : {}),
      ...(userAgent ? { headers: { "user-agent": userAgent } } : {}),
    };
  }
  if (report.message) report.message = scrubText(report.message);
  for (const exception of report.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
  }
  report.breadcrumbs = report.breadcrumbs?.map((crumb) => scrubBreadcrumb(crumb));
  if (report.extra) report.extra = scrubValue(report.extra) as Record<string, unknown>;
  if (report.contexts)
    report.contexts = scrubValue(report.contexts) as Record<string, unknown>;
  if (report.tags) report.tags = scrubValue(report.tags) as Record<string, unknown>;
  return event;
}
