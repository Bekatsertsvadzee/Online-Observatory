import { Locale } from "@darkview/contracts";
import type { Locale as LocaleValue } from "@darkview/contracts";

/** Locales come from contracts/openapi.yaml, never from a second list here. */
export const locales = Object.values(Locale);

export type { LocaleValue as Locale };

export const defaultLocale: LocaleValue = Locale.EN;

export function isLocale(value: string): value is LocaleValue {
  return (locales as string[]).includes(value);
}
