import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { denialFor, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { createNotes, isTooBroad, listVaultChoices, nameVaults, setVault, vaultLocation } from "../src/vaults.js";

let dir;
let brain;
let other;
let notes;

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "smcp-notes-")));
  brain = join(dir, "Vaults", "brain");
  other = join(dir, "GitHub", "brain");
  await mkdir(join(brain, "projects"), { recursive: true });
  await mkdir(join(brain, ".obsidian"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(brain, "projects", "Plan Atlas.md"), "# Plan\nLanzar la versión móvil en enero.");
  await writeFile(join(brain, "diario.md"), "Hoy hablé del plan de ventas y de Atlas.");
  await writeFile(join(brain, ".obsidian", "secreto.md"), "atlas configuración interna");
  await writeFile(join(brain, "foto.png"), "atlas");
  await writeFile(join(dir, "fuera.md"), "atlas fuera de la bóveda");
  await symlink(join(dir, "fuera.md"), join(brain, "enlace.md"));
  notes = createNotes({ vaults: () => nameVaults([brain, other]) });
});
after(() => rm(dir, { recursive: true, force: true }));

test("dos bóvedas con el mismo nombre se distinguen por su carpeta", () => {
  assert.deepEqual(nameVaults([brain, other]).map((vault) => vault.name), ["brain (Vaults)", "brain (GitHub)"]);
  assert.deepEqual(nameVaults([brain]).map((vault) => vault.name), ["brain"]);
});

test("solo quedan visibles las bóvedas encendidas; detectar no es conectar", async () => {
  const registry = join(dir, "obsidian.json");
  const configPath = join(dir, "vaults.json");
  await writeFile(registry, JSON.stringify({ vaults: { a: { path: brain, ts: 2 }, b: { path: other, ts: 1 }, c: { path: join(dir, "no-existe"), ts: 3 } } }));
  assert.deepEqual(listVaultChoices({ registry, configPath }).map((vault) => vault.enabled), [false, false]);
  setVault(brain, true, configPath);
  const choices = listVaultChoices({ registry, configPath });
  assert.equal(choices.length, 2);
  assert.equal(choices.find((vault) => vault.path === brain).enabled, true);
  setVault(brain, false, configPath);
  assert.equal(listVaultChoices({ registry, configPath }).some((vault) => vault.enabled), false);
});

test("muestra la ubicación de forma legible", () => {
  const home = "/Users/ana";
  assert.equal(vaultLocation(`${home}/Library/Mobile Documents/iCloud~md~obsidian/Documents/Nube`, home), "iCloud · Obsidian");
  assert.equal(vaultLocation(`${home}/Library/CloudStorage/GoogleDrive-ana@x.com/My Drive/Proyectos/Mapa`, home), "Google Drive · Proyectos");
  assert.equal(vaultLocation(`${home}/Vaults/brain`, home), "~/Vaults");
});

test("rechaza carpetas demasiado amplias", () => {
  assert.equal(isTooBroad(homedir()), true);
  assert.equal(isTooBroad("/"), true);
  assert.equal(isTooBroad(brain), false);
  assert.throws(() => setVault(homedir(), true, join(dir, "x.json")), /amplia/);
});

test("busca por título y contenido, título primero, sin entrar a carpetas ocultas ni archivos que no son notas", async () => {
  const result = await notes.search({ query: "atlas plan", vault: "brain (Vaults)" });
  assert.deepEqual(result.notes.map((note) => note.path), [join("projects", "Plan Atlas.md"), "diario.md"]);
  assert.ok(result.notes[1].snippet.includes("plan"));
  const all = await notes.search({ query: "atlas" });
  assert.ok(!all.notes.some((note) => note.path.includes(".obsidian") || note.path.endsWith(".png")));
});

test("no sale de la bóveda: ni con .., ni por enlaces, ni a carpetas ocultas", async () => {
  const vault = "brain (Vaults)";
  await assert.rejects(notes.read({ vault, path: "../fuera.md" }), /fuera de la bóveda/);
  await assert.rejects(notes.read({ vault, path: "enlace.md" }), /fuera de la bóveda/);
  await assert.rejects(notes.read({ vault, path: ".obsidian/secreto.md" }), /fuera de la bóveda/);
  await assert.rejects(notes.read({ vault, path: "foto.png" }), /\.md/);
  await assert.rejects(notes.write({ vault, path: "../nueva.md", content: "x" }), /fuera de la bóveda/);
  await assert.rejects(notes.read({ vault: "otra", path: "diario.md" }), /No hay una bóveda/);
});

test("lee notas y escribe sin pisar notas existentes salvo que se pida", async () => {
  const vault = "brain (Vaults)";
  assert.match((await notes.read({ vault, path: "diario.md" })).content, /plan de ventas/);
  await notes.write({ vault, path: "inbox/idea.md", content: "uno" });
  await assert.rejects(notes.write({ vault, path: "inbox/idea.md", content: "dos" }), /ya existe/);
  await notes.write({ vault, path: "inbox/idea.md", content: "-dos", mode: "append" });
  assert.equal(await readFile(join(brain, "inbox", "idea.md"), "utf8"), "uno-dos");
});

test("sin bóvedas encendidas, el error dice dónde encenderlas", async () => {
  const empty = createNotes({ vaults: () => [] });
  await assert.rejects(empty.search({ query: "x" }), /Conexiones > Notas/);
});

test("desde el teléfono se puede leer notas pero no escribirlas", () => {
  for (const name of ["notes_list_vaults", "notes_search", "notes_recent", "notes_read"]) assert.ok(REMOTE_TOOLS.has(name), name);
  assert.ok(!REMOTE_TOOLS.has("notes_write"));
  assert.equal(toolGroup("notes_write"), "notes");
  const policy = { paused: false, readOnly: true, disabled: { notes: false } };
  assert.match(denialFor("notes_write", { destructiveHint: true }, policy), /solo lectura/);
});
