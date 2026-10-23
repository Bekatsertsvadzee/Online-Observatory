/**
 * ADR-062. What each outbox email says, in English and Georgian.
 *
 * Read from the `data` the dispatcher builds at the moment of sending, so it is always
 * the booking, capture, voucher or prize as it stands now. The product is Stellar to a
 * customer (ADR-025). Every link goes to the website's page for the thing the email is
 * about, where the full and current state is; an email never says more than that page.
 */
export type EmailLocale = "en" | "ka";
export type EmailContent = { subject: string; text: string; html: string };

type Names = { nameEn: string; nameKa: string };
type Data = Record<string, unknown>;

type Draft = {
  subject: string;
  paragraphs: string[];
  /** A quoted message from a person, set apart from the rest. */
  quote?: string;
  /** A value the reader copies, such as a gift code. */
  code?: string;
  action: { label: string; path: string };
};

const SIGNATURE: Record<EmailLocale, string> = { en: "Stellar", ka: "სტელარი" };
const GREETING: Record<EmailLocale, string> = { en: "Hello,", ka: "გამარჯობა," };

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function name(locale: EmailLocale, names: unknown) {
  const value = names as Names;
  return locale === "ka" ? value.nameKa : value.nameEn;
}

/** "15 December 2026, 22:00" in the observatory's own time. */
export function when(locale: EmailLocale, iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale === "ka" ? "ka-GE" : "en-GB", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** "21:15" in the observatory's own time. */
function clock(locale: EmailLocale, iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale === "ka" ? "ka-GE" : "en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** "15 December 2026": a voucher's or prize's last day, in the observatory's time. */
function day(locale: EmailLocale, iso: string, timeZone = "Asia/Tbilisi") {
  return new Intl.DateTimeFormat(locale === "ka" ? "ka-GE" : "en-GB", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

function money(minor: unknown, currency: unknown) {
  return `${(Number(minor) / 100).toFixed(2)} ${String(currency)}`;
}

function session(locale: EmailLocale, data: Data) {
  const observatory = data.observatory as Names & { timezone: string };
  return {
    target: name(locale, data.target),
    observatory: name(locale, observatory),
    at: when(locale, String(data.slotStartAt), observatory.timezone),
    minutes: Number(data.durationMinutes),
    timezone: observatory.timezone,
  };
}

function prizeText(locale: EmailLocale, data: Data) {
  const minutes = data.durationMinutes;
  const percent = data.percentOff;
  if (locale === "ka") {
    if (data.kind === "FREE_SLOT") return `უფასო ${minutes}-წუთიანი სეანსი`;
    if (data.kind === "OBSERVER_SEAT") return "დამკვირვებლის უფასო ადგილი";
    return `${percent}%-იანი ფასდაკლება ერთ ჯავშანზე`;
  }
  if (data.kind === "FREE_SLOT") return `a free ${minutes}-minute session`;
  if (data.kind === "OBSERVER_SEAT") return "a free observer seat";
  return `${percent}% off one booking`;
}

const CAUSE: Record<EmailLocale, Record<string, string>> = {
  en: { WEATHER: "the weather", OBSERVATORY_FAULT: "an observatory fault" },
  ka: { WEATHER: "ამინდის", OBSERVATORY_FAULT: "ობსერვატორიის ხარვეზის" },
};

const DRAFTS: Record<string, Record<EmailLocale, (data: Data) => Draft>> = {
  BOOKING_CONFIRMED: {
    en: (data) => {
      const s = session("en", data);
      return {
        subject: `Booked: ${s.target}, ${s.at}`,
        paragraphs: [
          `Your live session is confirmed: ${s.target}, ${s.minutes} minutes from ${s.at}, ${s.observatory} time.`,
          "Open your booking a few minutes before the start to join the live room.",
        ],
        action: { label: "See your booking", path: `/en/app/bookings/${data.bookingId}` },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      return {
        subject: `დაჯავშნილია: ${s.target}, ${s.at}`,
        paragraphs: [
          `შენი პირდაპირი სეანსი დადასტურებულია: ${s.target}, ${s.minutes} წუთი, ${s.at}-დან (${s.observatory}, ადგილობრივი დრო).`,
          "სეანსის დაწყებამდე რამდენიმე წუთით ადრე გახსენი ჯავშანი და შეუერთდი პირდაპირ ეთერს.",
        ],
        action: { label: "ჯავშნის ნახვა", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  SLOT_REMINDER: {
    en: (data) => {
      const s = session("en", data);
      return {
        subject: `Starting soon: ${s.target}`,
        paragraphs: [
          `Your live session of ${s.target} starts at ${s.at}, ${s.observatory} time.`,
          "Join from your booking a few minutes early, so the telescope is yours from the first minute.",
        ],
        action: {
          label: "Open your booking",
          path: `/en/app/bookings/${data.bookingId}`,
        },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      return {
        subject: `მალე იწყება: ${s.target}`,
        paragraphs: [
          `შენი პირდაპირი სეანსი — ${s.target} — იწყება ${s.at}-ზე (${s.observatory}, ადგილობრივი დრო).`,
          "შეუერთდი ჯავშნიდან რამდენიმე წუთით ადრე, რომ ტელესკოპი პირველივე წუთიდან შენი იყოს.",
        ],
        action: { label: "ჯავშნის გახსნა", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  WEATHER_HOLD: {
    en: (data) => {
      const s = session("en", data);
      return {
        subject: `On hold for the weather: ${s.target}`,
        paragraphs: [
          `The sky over ${s.observatory} is not clear enough for your session of ${s.target} at ${s.at}.`,
          "Your booking shows what happens next.",
        ],
        action: { label: "See your booking", path: `/en/app/bookings/${data.bookingId}` },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      return {
        subject: `ამინდის გამო შეჩერებულია: ${s.target}`,
        paragraphs: [
          `ობსერვატორიის თავზე ცა საკმარისად მოწმენდილი არ არის შენი სეანსისთვის — ${s.target}, ${s.at} (${s.observatory}).`,
          "რა მოხდება შემდეგ, ჯავშანში ნახავ.",
        ],
        action: { label: "ჯავშნის ნახვა", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  ENTITLEMENT_AVAILABLE: {
    en: (data) => {
      const s = session("en", data);
      const entitlement = data.entitlement as {
        cause: string;
        minutesLost: number;
        expiresAt: string | null;
      };
      return {
        subject: `A refund or a free session: ${s.target}`,
        paragraphs: [
          `${entitlement.minutesLost} minutes of your session of ${s.target} at ${s.at} were lost to ${CAUSE.en[entitlement.cause]}.`,
          entitlement.expiresAt
            ? `You can take a refund or a free session until ${day("en", entitlement.expiresAt, s.timezone)}.`
            : "You can take a refund or a free session.",
        ],
        action: {
          label: "Choose on your booking",
          path: `/en/app/bookings/${data.bookingId}`,
        },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      const entitlement = data.entitlement as {
        cause: string;
        minutesLost: number;
        expiresAt: string | null;
      };
      return {
        subject: `თანხის დაბრუნება ან უფასო სეანსი: ${s.target}`,
        paragraphs: [
          `შენი სეანსიდან — ${s.target}, ${s.at} — ${entitlement.minutesLost} წუთი ${CAUSE.ka[entitlement.cause]} გამო დაიკარგა.`,
          entitlement.expiresAt
            ? `${day("ka", entitlement.expiresAt, s.timezone)}-მდე შეგიძლია თანხა დაიბრუნო ან უფასო სეანსი აირჩიო.`
            : "შეგიძლია თანხა დაიბრუნო ან უფასო სეანსი აირჩიო.",
        ],
        action: { label: "არჩევა ჯავშანში", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  BOOKING_REFUNDED: {
    en: (data) => {
      const s = session("en", data);
      const refund = data.refund as { priceMinor: number; currency: string };
      return {
        subject: `Refunded: ${s.target}, ${s.at}`,
        paragraphs: [
          `Your booking of ${s.target} at ${s.at} was refunded: ${money(refund.priceMinor, refund.currency)}, to the way you paid.`,
        ],
        action: { label: "See your booking", path: `/en/app/bookings/${data.bookingId}` },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      const refund = data.refund as { priceMinor: number; currency: string };
      return {
        subject: `თანხა დაბრუნდა: ${s.target}, ${s.at}`,
        paragraphs: [
          `ჯავშნის — ${s.target}, ${s.at} — თანხა დაგიბრუნდა: ${money(refund.priceMinor, refund.currency)}, გადახდის იმავე გზით.`,
        ],
        action: { label: "ჯავშნის ნახვა", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  SUBSCRIPTION_MINUTES_RETURNED: {
    en: (data) => {
      const s = session("en", data);
      return {
        subject: `${data.minutesReturned} minutes back in your subscription`,
        paragraphs: [
          `${data.minutesReturned} minutes are back in your subscription, from your booking of ${s.target} at ${s.at}.`,
        ],
        action: { label: "See your booking", path: `/en/app/bookings/${data.bookingId}` },
      };
    },
    ka: (data) => {
      const s = session("ka", data);
      return {
        subject: `${data.minutesReturned} წუთი გამოწერას დაუბრუნდა`,
        paragraphs: [
          `შენს გამოწერას ${data.minutesReturned} წუთი დაუბრუნდა ჯავშნიდან — ${s.target}, ${s.at}.`,
        ],
        action: { label: "ჯავშნის ნახვა", path: `/ka/app/bookings/${data.bookingId}` },
      };
    },
  },
  CAPTURE_READY: {
    en: (data) => {
      const target = name("en", data.target);
      return {
        subject: `In your Collection: ${target}`,
        paragraphs: [
          `Your capture of ${target} is in your Collection.`,
          ...(data.simulated
            ? ["It was made by the simulator, and is marked Simulated."]
            : []),
        ],
        action: {
          label: "Open the capture",
          path: `/en/app/collection/${data.captureId}`,
        },
      };
    },
    ka: (data) => {
      const target = name("ka", data.target);
      return {
        subject: `შენს კოლექციაშია: ${target}`,
        paragraphs: [
          `შენი კადრი — ${target} — კოლექციაში დაემატა.`,
          ...(data.simulated
            ? ["ის სიმულატორმა შექმნა და მონიშნულია, როგორც სიმულაცია."]
            : []),
        ],
        action: { label: "კადრის გახსნა", path: `/ka/app/collection/${data.captureId}` },
      };
    },
  },
  OBSERVER_PACK_REFUNDED: {
    en: (data) => {
      const refund = data.refund as {
        refundedMinor: number;
        priceMinor: number;
        currency: string;
      };
      return {
        subject: `Your observer seat was refunded: ${name("en", data.target)}`,
        paragraphs: [
          `The session of ${name("en", data.target)} at ${name("en", data.observatory)} was closed to observers, so your seat was refunded: ${money(refund.refundedMinor, refund.currency)} of the ${money(refund.priceMinor, refund.currency)} paid.`,
        ],
        action: { label: "Your nights", path: "/en/app" },
      };
    },
    ka: (data) => {
      const refund = data.refund as {
        refundedMinor: number;
        priceMinor: number;
        currency: string;
      };
      return {
        subject: `დამკვირვებლის ადგილის თანხა დაბრუნდა: ${name("ka", data.target)}`,
        paragraphs: [
          `სეანსი — ${name("ka", data.target)}, ${name("ka", data.observatory)} — დამკვირვებლებისთვის დაიხურა, ამიტომ ადგილის თანხა დაგიბრუნდა: ${money(refund.refundedMinor, refund.currency)}, გადახდილი ${money(refund.priceMinor, refund.currency)}-დან.`,
        ],
        action: { label: "შენი ღამეები", path: "/ka/app" },
      };
    },
  },
  GIFT_VOUCHER_ISSUED: {
    en: (data) => ({
      subject: `A ${data.durationMinutes}-minute live session at the telescope, for you`,
      paragraphs: [
        `${data.buyerName ? String(data.buyerName) : "Someone"} gave you a ${data.durationMinutes}-minute live session at Stellar: a real telescope in Tbilisi, pointed where you choose.`,
        data.expiresAt
          ? `Enter this code when you book, until ${day("en", String(data.expiresAt))}:`
          : "Enter this code when you book:",
      ],
      quote: data.message ? String(data.message) : undefined,
      code: String(data.code),
      action: { label: "Book a session", path: "/en/app/book" },
    }),
    ka: (data) => ({
      subject: `${data.durationMinutes}-წუთიანი პირდაპირი სეანსი ტელესკოპთან — შენთვის`,
      paragraphs: [
        `შენ გაჩუქეს ${data.durationMinutes}-წუთიანი პირდაპირი სეანსი სტელარში: ნამდვილი ტელესკოპი თბილისში, რომელიც იქით მიიმართება, საითაც შენ აირჩევ.`,
        ...(data.buyerName ? [`საჩუქრის ავტორი: ${String(data.buyerName)}.`] : []),
        data.expiresAt
          ? `ეს კოდი ჯავშნისას შეიყვანე, ${day("ka", String(data.expiresAt))}-მდე:`
          : "ეს კოდი ჯავშნისას შეიყვანე:",
      ],
      quote: data.message ? String(data.message) : undefined,
      code: String(data.code),
      action: { label: "სეანსის დაჯავშნა", path: "/ka/app/book" },
    }),
  },
  GIFT_VOUCHER_RESTORED: {
    en: (data) => ({
      subject: "Your gift voucher can be used again",
      paragraphs: [
        `The booking your gift voucher ending ${data.codeLast4} paid for was cancelled, so the voucher can be used again${data.expiresAt ? `, until ${day("en", String(data.expiresAt))}` : ""}.`,
      ],
      action: { label: "Book a session", path: "/en/app/book" },
    }),
    ka: (data) => ({
      subject: "სასაჩუქრე ვაუჩერი ისევ შეგიძლია გამოიყენო",
      paragraphs: [
        `ჯავშანი, რომელიც ${data.codeLast4}-ით დამთავრებული ვაუჩერით გადაიხადე, გაუქმდა, ამიტომ ვაუჩერი ისევ მოქმედებს${data.expiresAt ? ` ${day("ka", String(data.expiresAt))}-მდე` : ""}.`,
      ],
      action: { label: "სეანსის დაჯავშნა", path: "/ka/app/book" },
    }),
  },
  WAITLIST_OFFER: {
    en: (data) => {
      const observatory = data.observatory as Names & { timezone: string };
      const at = when("en", String(data.slotStartAt), observatory.timezone);
      const until = clock("en", String(data.offerExpiresAt), observatory.timezone);
      return {
        subject: `The slot you waited for is free: ${at}`,
        paragraphs: [
          `The ${data.durationMinutes}-minute session at ${observatory.nameEn}, ${at} local time, has come free, and it is held for you until ${until}.`,
          "Reserve it on the booking page and pay as usual. After that, it goes to the next person waiting.",
        ],
        action: {
          label: "Reserve it",
          path: `/en/app/book?startAt=${encodeURIComponent(String(data.slotStartAt))}`,
        },
      };
    },
    ka: (data) => {
      const observatory = data.observatory as Names & { timezone: string };
      const at = when("ka", String(data.slotStartAt), observatory.timezone);
      const until = clock("ka", String(data.offerExpiresAt), observatory.timezone);
      return {
        subject: `სეანსი, რომელსაც ელოდი, გათავისუფლდა: ${at}`,
        paragraphs: [
          `${data.durationMinutes}-წუთიანი სეანსი — ${observatory.nameKa}, ${at} (ადგილობრივი დრო) — გათავისუფლდა და ${until}-მდე შენთვისაა დაკავებული.`,
          "დაჯავშნე ჯავშნის გვერდზე და გადაიხადე ჩვეულებრივ. ამის შემდეგ ის რიგში შემდეგს გადაეცემა.",
        ],
        action: {
          label: "დაჯავშნა",
          path: `/ka/app/book?startAt=${encodeURIComponent(String(data.slotStartAt))}`,
        },
      };
    },
  },
  CARD_PRIZE_WON: {
    en: (data) => {
      const observatory = data.observatory as Names & { timezone: string };
      return {
        subject: `Your weekly card: ${prizeText("en", data)}`,
        paragraphs: [
          `The card you turned this week held ${prizeText("en", data)}, at ${observatory.nameEn}.`,
          `It is yours to use until ${day("en", String(data.expiresAt), observatory.timezone)}. Its code is on the cards page.`,
        ],
        action: { label: "See your prize", path: "/en/app/cards" },
      };
    },
    ka: (data) => {
      const observatory = data.observatory as Names & { timezone: string };
      return {
        subject: `შენი კვირის ბარათი: ${prizeText("ka", data)}`,
        paragraphs: [
          `ამ კვირას გადაბრუნებულ ბარათში იყო ${prizeText("ka", data)} — ${observatory.nameKa}.`,
          `მისი გამოყენება შეგიძლია ${day("ka", String(data.expiresAt), observatory.timezone)}-მდე. კოდი ბარათების გვერდზეა.`,
        ],
        action: { label: "პრიზის ნახვა", path: "/ka/app/cards" },
      };
    },
  },
};

export function renderEmail(input: {
  kind: string;
  locale: string;
  data: Data;
  appUrl: string;
}): EmailContent {
  const locale: EmailLocale = input.locale === "ka" ? "ka" : "en";
  const drafts = DRAFTS[input.kind];
  if (!drafts) throw new Error(`No email template for ${input.kind}`);
  const draft = drafts[locale](input.data);
  const href = new URL(draft.action.path, input.appUrl).toString();

  const text = [
    GREETING[locale],
    ...draft.paragraphs,
    ...(draft.quote ? [`"${draft.quote}"`] : []),
    ...(draft.code ? [draft.code] : []),
    `${draft.action.label}: ${href}`,
    SIGNATURE[locale],
  ].join("\n\n");

  const html = [
    `<p>${escapeHtml(GREETING[locale])}</p>`,
    ...draft.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(draft.quote ? [`<blockquote>${escapeHtml(draft.quote)}</blockquote>`] : []),
    ...(draft.code
      ? [
          `<p style="font-family:monospace;font-size:20px;letter-spacing:2px">${escapeHtml(draft.code)}</p>`,
        ]
      : []),
    `<p><a href="${escapeHtml(href)}">${escapeHtml(draft.action.label)}</a></p>`,
    `<p>${escapeHtml(SIGNATURE[locale])}</p>`,
  ].join("");

  return { subject: `${draft.subject} — ${SIGNATURE[locale]}`, text, html };
}
