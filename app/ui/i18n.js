// English is the source language; other languages are dictionaries keyed by the English text.
// Loaded as a plain script in the windows and imported for its side effects in the main process.
(function (root) {
  // Each language: its locale for dates and numbers, and its own name for the language menus.
  // Keep in step with src/languages.js (a test checks it).
  const LANGUAGES = {
    en: { locale: "en-US", name: "English" },
    es: { locale: "es-MX", name: "Español" },
    pt: { locale: "pt-BR", name: "Português" },
    fr: { locale: "fr-FR", name: "Français" },
    de: { locale: "de-DE", name: "Deutsch" },
    it: { locale: "it-IT", name: "Italiano" },
  };
  // A dictionary is globalThis.SMCP_<CODE>, filled by the files in i18n/.
  const dictionary = (code) => root[`SMCP_${code.toUpperCase()}`];
  let language = "en";

  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
  }

  /** Translates English text; text with no translation is shown in English. */
  function tr(text, params) {
    const translated = language === "en" ? text : (dictionary(language)?.[text] ?? text);
    return fill(translated, params);
  }

  function translateText(value) {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const translated = tr(trimmed);
    return translated === trimmed ? value : value.replace(trimmed, translated);
  }

  /** Translates static markup, including templates that are cloned later. */
  function translatePage(node) {
    const attributes = ["placeholder", "title", "aria-label"];
    const walk = (current) => {
      for (const child of current.childNodes) {
        if (child.nodeType === 3) child.nodeValue = translateText(child.nodeValue);
        else if (child.nodeType === 1) {
          for (const name of attributes) {
            if (child.hasAttribute(name)) child.setAttribute(name, translateText(child.getAttribute(name)));
          }
          if (child.tagName === "TEMPLATE") walk(child.content);
          else if (child.tagName !== "SCRIPT" && child.tagName !== "STYLE") walk(child);
        }
      }
    };
    walk(node);
  }

  root.SMCP_I18N = {
    setLanguage(value) {
      language = Object.hasOwn(LANGUAGES, value) ? value : "en";
    },
    language: () => language,
    locale: () => LANGUAGES[language].locale,
    /** [code, name] pairs for a language menu, each name written in its own language. */
    languages: () => Object.entries(LANGUAGES).map(([code, { name }]) => [code, name]),
    translatePage,
    tr,
  };
  root.tr = tr;

  if (root.api?.language) {
    root.SMCP_I18N.setLanguage(root.api.language);
    root.addEventListener("DOMContentLoaded", () => {
      root.document.documentElement.lang = language;
      root.SMCP_I18N.translatePage(root.document);
    });
  }
})(globalThis);
