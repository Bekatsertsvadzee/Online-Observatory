/**
 * The Phase 1 target catalogue — Build Plan section 01.
 *
 * Twelve objects, all confirmed to fit an available field of view and all bright
 * enough for a Bortle 8–9 sky. This list is closed: adding a target means
 * confirming it fits one of the three optical configurations first.
 *
 * M31, the Pleiades and the Double Cluster are deliberately absent. At 190′, 110′
 * and 60′ they are wider than the largest available field (40.5′ at f/6.3), so
 * they cannot be framed. The Build Plan says so explicitly: "Do not put them in
 * the catalogue."
 *
 * Sizes, magnitudes and optical configurations are the Build Plan's own values.
 * Where it gives a range — Mars 0.1–0.4′, Venus 0.2–1.0′ — the larger figure is
 * stored, because what matters is whether the object fits the frame at its
 * biggest.
 *
 * TWO THINGS NEED A HUMAN BEFORE LAUNCH:
 *
 *  1. J2000 coordinates below are standard catalogue positions and should be
 *     checked against SIMBAD. They drive a real mount.
 *  2. The Georgian names follow docs/georgian-terminology.md where it has a term,
 *     but the object names themselves are not in it and need a native reviewer.
 *     That document has a "Human review required" section for exactly this.
 */

export type Phase1Target = {
  id: string;
  slug: string;
  catalogId: string | null;
  nameEn: string;
  nameKa: string;
  type: "MOON" | "PLANET" | "DOUBLE_STAR" | "GLOBULAR_CLUSTER" | "PLANETARY_NEBULA" | "BRIGHT_NEBULA";
  positionSource: "FIXED" | "EPHEMERIS";
  solarSystemBody: string | null;
  rightAscensionHours: number | null;
  declinationDegrees: number | null;
  angularSizeArcmin: number;
  magnitude: number;
  opticalConfig: "F20_BARLOW" | "F10_NATIVE" | "F6_3_REDUCER";
  imagingProfile: "LUNAR" | "PLANETARY" | "DOUBLE_STAR" | "GLOBULAR_CLUSTER" | "PLANETARY_NEBULA" | "BRIGHT_NEBULA";
  minAltitudeDegrees: number;
  expectedMissionMinutes: number;
  descriptionEn: string;
  descriptionKa: string;
};

/**
 * Build Plan section 01: "A target may only be offered when ... its altitude
 * exceeds 25°". One figure, applied to every target; the scheduler adds the Sun,
 * Moon and field-of-view rules at request time (DV-053).
 */
const MIN_ALTITUDE_DEGREES = 25;

/**
 * Session length is NOT specified per target anywhere in the Build Plan. These are
 * derived from the observing method and must be confirmed against the /pricing
 * page before launch:
 *
 *   short  — short exposures, no stacking needed to show something worth seeing
 *   stacked — the Build Plan says these "need live stacking", which takes time
 *
 * Both sit under the 45-minute ceiling that Build Plan Q3 sets as the maximum
 * mission length, itself provisional until unattended tracking is measured.
 */
const SHORT_SESSION_MINUTES = 15;
const STACKED_SESSION_MINUTES = 30;

export const PHASE1_TARGETS: readonly Phase1Target[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    slug: "moon-terminator",
    catalogId: null,
    nameEn: "Moon — terminator",
    nameKa: "მთვარე — ტერმინატორი",
    type: "MOON",
    positionSource: "EPHEMERIS",
    solarSystemBody: "MOON",
    rightAscensionHours: null,
    declinationDegrees: null,
    // 31′ is the full disc, which fits no configuration. The product is the
    // terminator close-up, not the whole Moon: crater shadows at 0.4″/px.
    angularSizeArcmin: 31,
    magnitude: -12,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "LUNAR",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn:
      "The strongest object we can show. Crater shadows along the terminator, sharpest three to ten days after new moon.",
    descriptionKa:
      "ყველაზე შთამბეჭდავი ობიექტი. კრატერების ჩრდილები ტერმინატორის გასწვრივ, საუკეთესოდ ახალმთვარობიდან 3–10 დღეში.",
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    slug: "jupiter",
    catalogId: null,
    nameEn: "Jupiter and its moons",
    nameKa: "იუპიტერი და მისი მთვარეები",
    type: "PLANET",
    positionSource: "EPHEMERIS",
    solarSystemBody: "JUPITER",
    rightAscensionHours: null,
    declinationDegrees: null,
    angularSizeArcmin: 0.6,
    magnitude: -2.5,
    opticalConfig: "F20_BARLOW",
    imagingProfile: "PLANETARY",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "Cloud belts and the four Galilean moons. Reliable, and best near opposition.",
    descriptionKa: "ღრუბლოვანი სარტყლები და ოთხი გალილეური მთვარე. საიმედო ობიექტი, საუკეთესოდ დაპირისპირებასთან ახლოს.",
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    slug: "saturn",
    catalogId: null,
    nameEn: "Saturn",
    nameKa: "სატურნი",
    type: "PLANET",
    positionSource: "EPHEMERIS",
    solarSystemBody: "SATURN",
    rightAscensionHours: null,
    declinationDegrees: null,
    angularSizeArcmin: 0.7,
    magnitude: 0.5,
    opticalConfig: "F20_BARLOW",
    imagingProfile: "PLANETARY",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "The rings resolve clearly at 0.2 arcseconds per pixel. The object most people come back for.",
    descriptionKa: "რგოლები მკაფიოდ ჩანს 0.2 რკალწამი/პიქსელზე. ობიექტი, რომლისთვისაც ადამიანები ბრუნდებიან.",
  },
  {
    id: "00000000-0000-4000-8000-000000000104",
    slug: "mars",
    catalogId: null,
    nameEn: "Mars",
    nameKa: "მარსი",
    type: "PLANET",
    positionSource: "EPHEMERIS",
    solarSystemBody: "MARS",
    rightAscensionHours: null,
    declinationDegrees: null,
    // 0.1–0.4′ in the Build Plan. The larger figure is stored; the scheduler
    // gates on apparent diameter, because away from opposition Mars is a dot.
    angularSizeArcmin: 0.4,
    magnitude: -1,
    opticalConfig: "F20_BARLOW",
    imagingProfile: "PLANETARY",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "Worth observing only near opposition, when the disc is large enough to show surface markings.",
    descriptionKa: "დაკვირვების ღირსია მხოლოდ დაპირისპირებასთან ახლოს, როცა დისკი საკმარისად დიდია.",
  },
  {
    id: "00000000-0000-4000-8000-000000000105",
    slug: "venus",
    catalogId: null,
    nameEn: "Venus — phase",
    nameKa: "ვენერა — ფაზა",
    type: "PLANET",
    positionSource: "EPHEMERIS",
    solarSystemBody: "VENUS",
    rightAscensionHours: null,
    declinationDegrees: null,
    angularSizeArcmin: 1.0,
    magnitude: -4,
    opticalConfig: "F20_BARLOW",
    imagingProfile: "PLANETARY",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "A crescent, like a small moon. Reads well even in twilight, near greatest elongation.",
    descriptionKa: "ნახევარმთვარისებრი ფაზა. კარგად ჩანს ბინდშიც, უდიდეს ელონგაციასთან ახლოს.",
  },
  {
    id: "00000000-0000-4000-8000-000000000106",
    slug: "albireo",
    catalogId: "Beta Cygni",
    nameEn: "Albireo",
    nameKa: "ალბირეო",
    type: "DOUBLE_STAR",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 19.512,
    declinationDegrees: 27.9597,
    angularSizeArcmin: 35 / 60, // 35″ separation
    magnitude: 3.1,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "DOUBLE_STAR",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "A gold and blue pair, and the one target that works in full moonlight.",
    descriptionKa: "ოქროსფერი და ცისფერი წყვილი — ერთადერთი ობიექტი, რომელიც სავსემთვარეობაზეც მუშაობს.",
  },
  {
    id: "00000000-0000-4000-8000-000000000107",
    slug: "mizar-alcor",
    catalogId: "Zeta Ursae Majoris",
    nameEn: "Mizar and Alcor",
    nameKa: "მიწარი და ალკორი",
    type: "DOUBLE_STAR",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 13.3987,
    declinationDegrees: 54.9253,
    angularSizeArcmin: 14,
    magnitude: 2.2,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "DOUBLE_STAR",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: SHORT_SESSION_MINUTES,
    descriptionEn: "Circumpolar from Tbilisi, so available on almost any clear night. Mizar itself splits at 14 arcseconds.",
    descriptionKa: "თბილისიდან ცირკუმპოლარულია და თითქმის ყოველ მოწმენდილ ღამეს ხელმისაწვდომია.",
  },
  {
    id: "00000000-0000-4000-8000-000000000108",
    slug: "m13-hercules-cluster",
    catalogId: "M13",
    nameEn: "Hercules Cluster",
    nameKa: "ჰერკულესის სფერული გროვა",
    type: "GLOBULAR_CLUSTER",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 16.6948,
    declinationDegrees: 36.4599,
    angularSizeArcmin: 20,
    magnitude: 5.8,
    opticalConfig: "F6_3_REDUCER",
    imagingProfile: "GLOBULAR_CLUSTER",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: STACKED_SESSION_MINUTES,
    descriptionEn: "Hundreds of thousands of stars. Live stacking is what resolves them from a city sky.",
    descriptionKa: "ასიათასობით ვარსკვლავი. ცოცხალი დასტაკვა საჭიროა ქალაქის ცაზე მათ გასარჩევად.",
  },
  {
    id: "00000000-0000-4000-8000-000000000109",
    slug: "m57-ring-nebula",
    catalogId: "M57",
    nameEn: "Ring Nebula",
    nameKa: "რგოლისებრი ნისლეული",
    type: "PLANETARY_NEBULA",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 18.8931,
    declinationDegrees: 33.0292,
    angularSizeArcmin: 1.4,
    magnitude: 8.8,
    opticalConfig: "F10_NATIVE",
    imagingProfile: "PLANETARY_NEBULA",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: STACKED_SESSION_MINUTES,
    descriptionEn: "Small and bright per unit area, which is why it survives light pollution better than larger nebulae.",
    descriptionKa: "მცირე, მაგრამ ზედაპირული სიკაშკაშით — ამიტომ ქალაქის განათებას სხვებზე უკეთ უძლებს.",
  },
  {
    id: "00000000-0000-4000-8000-000000000110",
    slug: "m27-dumbbell-nebula",
    catalogId: "M27",
    nameEn: "Dumbbell Nebula",
    nameKa: "გირისებრი ნისლეული",
    type: "PLANETARY_NEBULA",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 19.9934,
    declinationDegrees: 22.7211,
    angularSizeArcmin: 8,
    magnitude: 7.4,
    opticalConfig: "F6_3_REDUCER",
    imagingProfile: "PLANETARY_NEBULA",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: STACKED_SESSION_MINUTES,
    descriptionEn: "A dying star's shed outer layers. One of the best live-stacking targets available to us.",
    descriptionKa: "მკვდარი ვარსკვლავის მოცილებული გარსი. ცოცხალი დასტაკვის ერთ-ერთი საუკეთესო ობიექტი.",
  },
  {
    id: "00000000-0000-4000-8000-000000000111",
    slug: "m42-orion-nebula",
    catalogId: "M42",
    nameEn: "Orion Nebula",
    nameKa: "ორიონის ნისლეული",
    type: "BRIGHT_NEBULA",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 5.5881,
    declinationDegrees: -5.3911,
    // The core, not the full nebula: 12′ is what fits and what we show.
    angularSizeArcmin: 12,
    magnitude: 4,
    opticalConfig: "F6_3_REDUCER",
    imagingProfile: "BRIGHT_NEBULA",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: STACKED_SESSION_MINUTES,
    descriptionEn: "The brightest deep-sky object we can offer, and the closest region of massive star formation.",
    descriptionKa: "ყველაზე კაშკაშა ღრმა ცის ობიექტი და მასიური ვარსკვლავწარმოქმნის უახლოესი არე.",
  },
  {
    id: "00000000-0000-4000-8000-000000000112",
    slug: "m15-globular-cluster",
    catalogId: "M15",
    nameEn: "Messier 15",
    nameKa: "M15 სფერული გროვა",
    type: "GLOBULAR_CLUSTER",
    positionSource: "FIXED",
    solarSystemBody: null,
    rightAscensionHours: 21.4995,
    declinationDegrees: 12.167,
    angularSizeArcmin: 18,
    magnitude: 6.2,
    opticalConfig: "F6_3_REDUCER",
    imagingProfile: "GLOBULAR_CLUSTER",
    minAltitudeDegrees: MIN_ALTITUDE_DEGREES,
    expectedMissionMinutes: STACKED_SESSION_MINUTES,
    descriptionEn: "An unusually compact core, which holds together well against a bright sky.",
    descriptionKa: "არაჩვეულებრივად კომპაქტური ბირთვი, რომელიც კაშკაშა ცაზეც კარგად ჩანს.",
  },
];

/**
 * Objects excluded from the catalogue on purpose, with the reason. Asserted in
 * tests so that "add M31, everyone knows Andromeda" cannot quietly happen: at
 * 190′ it is nearly five times wider than the largest field this telescope has.
 */
export const EXCLUDED_TARGETS = [
  { name: "M31 Andromeda Galaxy", angularSizeArcmin: 190 },
  { name: "Pleiades", angularSizeArcmin: 110 },
  { name: "Double Cluster", angularSizeArcmin: 60 },
] as const;

/** 40.5′ × 22.8′ at f/6.3, the widest configuration available. */
export const WIDEST_FIELD_ARCMIN = 40.5;

/** Catalogue target id by slug, for seeds and fixtures that need to reference one. */
export const targetIdBySlug = Object.fromEntries(
  PHASE1_TARGETS.map((target) => [target.slug, target.id]),
) as Record<string, string>;
