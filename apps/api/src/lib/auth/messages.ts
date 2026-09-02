import type { Locale } from "@/lib/locale";

// Seed material for DV-051. The API will return error codes and the client will
// render the copy; until that endpoint exists these strings keep the extracted
// authentication logic behaving exactly as it did before the split.
export const authErrors: Record<Locale, Record<string, string>> = {
  en: {
    invalidEmail: "Enter a valid email address.",
    shortName: "Enter at least two characters.",
    weakPassword: "Use a password between 12 and 128 characters.",
    invalidCredentials: "Email or password is incorrect.",
    unverified: "Verify your email before signing in.",
    rateLimited: "Too many attempts. Try again in 15 minutes.",
    unavailable: "Authentication is temporarily unavailable. Please try again later.",
  },
  ka: {
    invalidEmail: "შეიყვანე სწორი ელფოსტის მისამართი.",
    shortName: "შეიყვანე მინიმუმ ორი სიმბოლო.",
    weakPassword: "გამოიყენე 12-დან 128-მდე სიმბოლოს პაროლი.",
    invalidCredentials: "ელფოსტა ან პაროლი არასწორია.",
    unverified: "შესვლამდე დაადასტურე ელფოსტა.",
    rateLimited: "ცდების ლიმიტი ამოიწურა. სცადე 15 წუთში.",
    unavailable: "ავტორიზაცია დროებით მიუწვდომელია. მოგვიანებით სცადე.",
  },
};

export const authCopy: Record<Locale, { errors: Record<string, string> }> = {
  en: { errors: authErrors.en },
  ka: { errors: authErrors.ka },
};
