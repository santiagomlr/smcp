// English is the source language; other languages are dictionaries keyed by the English text.
// Loaded as a plain script in the windows and imported for its side effects in the main process.
(function (root) {
  const DICTIONARIES = () => ({ es: root.SMCP_ES ?? {} });
  const LOCALES = { en: "en-US", es: "es-MX" };
  let language = "en";

  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
  }

  /** Translates English text; text with no translation is shown in English. */
  function tr(text, params) {
    const translated = language === "en" ? text : (DICTIONARIES()[language]?.[text] ?? text);
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
      language = value in LOCALES ? value : "en";
    },
    language: () => language,
    locale: () => LOCALES[language],
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
