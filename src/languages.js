// The languages SMCP speaks. The app's own list lives in app/ui/i18n.js; a test keeps both the same.

export const LANGUAGES = {
  en: { locale: "en-US", english: "English" },
  es: { locale: "es-MX", english: "Spanish" },
  pt: { locale: "pt-BR", english: "Portuguese" },
  fr: { locale: "fr-FR", english: "French" },
  de: { locale: "de-DE", english: "German" },
  it: { locale: "it-IT", english: "Italian" },
};

export const isLanguage = (value) => Object.hasOwn(LANGUAGES, value);

/** The system's language when SMCP speaks it, otherwise English. */
export function systemLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const code = String(locale).toLowerCase().slice(0, 2);
  return isLanguage(code) ? code : "en";
}
