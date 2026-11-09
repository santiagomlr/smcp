// Every text the app shows through tr() must exist in every language, so no screen falls back to English.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const I18N = join(ROOT, "app", "ui", "i18n");

/** Each language is the set of es-*.js (or xx-*.js) files that fill globalThis.SMCP_XX. */
function dictionaries() {
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of readdirSync(I18N).filter((name) => name.endsWith(".js")).sort()) {
    vm.runInContext(readFileSync(join(I18N, file), "utf8"), sandbox, { filename: file });
  }
  return Object.fromEntries(
    Object.entries(sandbox)
      .filter(([name]) => /^SMCP_[A-Z]{2}$/.test(name))
      .map(([name, value]) => [name.slice(5).toLowerCase(), value]),
  );
}

function sources() {
  const ui = join(ROOT, "app", "ui");
  const core = join(ROOT, "app", "core");
  return [
    join(ROOT, "app", "main.js"),
    ...readdirSync(ui).filter((name) => name.endsWith(".js") && name !== "i18n.js").map((name) => join(ui, name)),
    ...readdirSync(core).filter((name) => name.endsWith(".js")).map((name) => join(core, name)),
  ];
}

/** Literal texts passed to tr(); texts built at run time cannot be checked here. */
function shownTexts() {
  const texts = new Map();
  for (const file of sources()) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const text = JSON.parse(`"${match[1]}"`);
      if (!texts.has(text)) texts.set(text, file.slice(ROOT.length));
    }
  }
  return texts;
}

const languages = dictionaries();

function appLanguages() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "app", "ui", "i18n.js"), "utf8"), sandbox);
  return [...sandbox.SMCP_I18N.languages().map(([code]) => String(code))];
}

test("every language in the menu has its dictionary, and every dictionary is in the menu", () => {
  assert.deepEqual(appLanguages().filter((code) => code !== "en").sort(), Object.keys(languages).sort());
});

test("the AI server speaks the same languages as the app", async () => {
  const { LANGUAGES } = await import("../src/languages.js");
  assert.deepEqual(Object.keys(LANGUAGES).sort(), appLanguages().sort());
});

test("every window and the main process load every dictionary file", () => {
  const files = readdirSync(I18N).filter((name) => name.endsWith(".js"));
  for (const page of ["index.html", "tasks.html", "tray.html"]) {
    const html = readFileSync(join(ROOT, "app", "ui", page), "utf8");
    for (const file of files) assert.ok(html.includes(`src="i18n/${file}"`), `${page} does not load i18n/${file}`);
  }
  const main = readFileSync(join(ROOT, "app", "main.js"), "utf8");
  for (const file of files) assert.ok(main.includes(`import "./ui/i18n/${file}";`), `main.js does not import i18n/${file}`);
});

for (const [language, dictionary] of Object.entries(languages)) {
  test(`every text has a ${language} translation`, () => {
    const missing = [...shownTexts()].filter(([text]) => !(text in dictionary)).map(([text, file]) => `${file}: ${JSON.stringify(text)}`);
    assert.deepEqual(missing, [], `Missing ${language} translations:\n${missing.join("\n")}`);
  });

  test(`${language} translations keep every {placeholder}`, () => {
    const broken = Object.entries(dictionary)
      .filter(([source, translated]) => {
        const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
        return names(source) !== names(translated);
      })
      .map(([source]) => source);
    assert.deepEqual(broken, [], `Placeholders differ in:\n${broken.join("\n")}`);
  });
}
