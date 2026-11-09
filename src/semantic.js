// Search notes by meaning, not only by exact words. The vectors come from macOS's own sentence
// embeddings (NaturalLanguage), so nothing is downloaded and no text leaves this computer.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { runJxa } from "./jxa.js";
import { enabledVaults, findVault, readHead, walkNotes } from "./vaults.js";

export const LANGUAGES = ["es", "en", "fr", "de", "it", "pt"];
const INDEX_VERSION = 1;
const CHUNK_CHARS = 700;
const MAX_CHUNKS = 4;
const MAX_NOTE_BYTES = 64 * 1024;
const BATCH = 80;
const MAX_INDEX_NOTES = 10_000;
const DEFAULT_BUDGET_MS = 40_000;

const EMBED_SCRIPT = `
ObjC.import("NaturalLanguage");
function main(a) {
  const embedding = $.NLEmbedding.sentenceEmbeddingForLanguage($(a.language));
  if (!embedding || embedding.isNil()) throw new Error("NO_MODEL");
  return a.texts.map((text) => {
    const vector = embedding.vectorForString($(text));
    if (!vector || vector.isNil()) return null;
    return ObjC.deepUnwrap(vector).map((x) => Math.round(x * 10000) / 10000);
  });
}`;

const DETECT_SCRIPT = `
ObjC.import("NaturalLanguage");
function main(a) {
  const recognizer = $.NLLanguageRecognizer.alloc.init;
  recognizer.processString($(a.text));
  const found = recognizer.dominantLanguage;
  return found && !found.isNil() ? found.js : null;
}`;

export function indexPath() {
  return process.env.SMCP_NOTES_INDEX || join(homedir(), ".smcp", "notes-index.json");
}

/** The default embedder: one osascript run per batch of texts. */
export function macEmbedder({ jxa = runJxa } = {}) {
  return {
    async embed(texts, language) {
      try {
        return await jxa("", EMBED_SCRIPT, { texts, language }, { timeoutMs: 60_000, failure: "" });
      } catch (error) {
        if (/NO_MODEL/.test(error.message)) throw new Error(`This Mac has no meaning model for the language "${language}".`);
        throw new Error("This Mac could not search by meaning. It needs macOS 11 or later.");
      }
    },
    async detect(text) {
      try {
        return await jxa("", DETECT_SCRIPT, { text }, { timeoutMs: 20_000, failure: "" });
      } catch {
        return null;
      }
    },
  };
}

/** Splits a note into a few pieces of about the same size, on paragraph boundaries when possible. */
export function chunkNote(title, text) {
  const body = String(text ?? "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\s+\n/g, "\n")
    .trim();
  const chunks = [];
  let current = "";
  for (const paragraph of body.split(/\n{2,}/)) {
    const piece = paragraph.replace(/\s+/g, " ").trim();
    if (!piece) continue;
    if (current && current.length + piece.length > CHUNK_CHARS) {
      chunks.push(current);
      current = "";
      if (chunks.length >= MAX_CHUNKS) break;
    }
    current = current ? `${current} ${piece}` : piece;
    while (current.length > CHUNK_CHARS && chunks.length < MAX_CHUNKS) {
      chunks.push(current.slice(0, CHUNK_CHARS));
      current = current.slice(CHUNK_CHARS);
    }
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
  if (!chunks.length) chunks.push("");
  // The title helps every piece: a note called "Viaje a Japón" is about Japan in every paragraph.
  return chunks.map((chunk) => ({ text: `${title}\n${chunk}`.trim(), preview: chunk.slice(0, 200) }));
}

export function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

export function decodeVector(text) {
  const buffer = Buffer.from(text, "base64");
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function loadIndex(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version === INDEX_VERSION && data.vaults && typeof data.vaults === "object") return data;
  } catch {
    // Missing or damaged: start again.
  }
  return { version: INDEX_VERSION, vaults: {} };
}

function saveIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(index), { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Keeps one index per vault and language, updated only for notes that changed. When a vault is
 * large, the first searches index for a while and answer with what is ready, saying so.
 */
export function createSemanticSearch({ vaults = () => enabledVaults(), embedder = macEmbedder(), path = indexPath(), now = Date.now, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const updateVault = async (index, vault, language, deadline) => {
    const root = await realpath(vault.path);
    const key = `${root}::${language}`;
    const saved = index.vaults[key]?.notes ?? {};
    const notes = {};
    const pending = [];
    let total = 0;
    for await (const file of walkNotes(root)) {
      if (++total > MAX_INDEX_NOTES) break;
      const rel = relative(root, file);
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const known = saved[rel];
      if (known && known.mtime === info.mtimeMs && known.size === info.size) notes[rel] = known;
      else pending.push({ rel, file, info });
    }
    let indexed = 0;
    let texts = [];
    let owners = [];
    const flush = async () => {
      if (!texts.length) return;
      const vectors = await embedder.embed(texts.map((item) => item.text), language);
      vectors.forEach((vector, i) => {
        if (!vector) return;
        const owner = owners[i];
        owner.entry.chunks.push({ v: encodeVector(vector), p: texts[i].preview });
      });
      texts = [];
      owners = [];
    };
    for (const item of pending) {
      if (now() > deadline) break;
      const text = await readHead(item.file, MAX_NOTE_BYTES).catch(() => "");
      const entry = { mtime: item.info.mtimeMs, size: item.info.size, modified: item.info.mtime.toISOString(), chunks: [] };
      notes[item.rel] = entry;
      for (const chunk of chunkNote(basename(item.file, extname(item.file)), text)) {
        texts.push(chunk);
        owners.push({ entry });
      }
      indexed += 1;
      if (texts.length >= BATCH) await flush();
    }
    await flush();
    index.vaults[key] = { notes };
    return { root, notes, total: Math.min(total, MAX_INDEX_NOTES), remaining: pending.length - indexed };
  };

  const chooseLanguage = async (language, sampleVaults) => {
    if (LANGUAGES.includes(language)) return language;
    let sample = "";
    for (const vault of sampleVaults) {
      const root = await realpath(vault.path).catch(() => null);
      if (!root) continue;
      for await (const file of walkNotes(root)) {
        sample += ` ${(await readHead(file, 2000).catch(() => "")).slice(0, 500)}`;
        if (sample.length > 6000) break;
      }
      if (sample.length > 6000) break;
    }
    const detected = sample.trim() ? await embedder.detect(sample) : null;
    return LANGUAGES.includes(detected) ? detected : "en";
  };

  return {
    async search({ query, vault, limit = 10, language = "auto" }) {
      const list = vaults();
      if (!list.length) throw new Error("No vaults are connected. Turn one on in the SMCP app, under Connections > Notes.");
      const targets = vault ? [findVault(list, vault)] : list;
      const chosen = await chooseLanguage(language, targets);
      const index = loadIndex(path);
      // A vault the person switched off leaves the index too, previews included.
      const connected = new Set(await Promise.all(list.map((item) => realpath(item.path).catch(() => item.path))));
      for (const key of Object.keys(index.vaults)) {
        if (!connected.has(key.split("::")[0])) delete index.vaults[key];
      }
      const deadline = now() + budgetMs;
      const states = [];
      for (const target of targets) states.push({ target, ...(await updateVault(index, target, chosen, deadline)) });
      saveIndex(path, index);

      const [queryVector] = await embedder.embed([String(query)], chosen);
      if (!queryVector) throw new Error("Could not understand that search. Try other words.");
      const results = [];
      for (const state of states) {
        for (const [rel, entry] of Object.entries(state.notes)) {
          let best = null;
          for (const chunk of entry.chunks) {
            const score = cosine(queryVector, decodeVector(chunk.v));
            if (!best || score > best.score) best = { score, preview: chunk.p };
          }
          if (best) results.push({ vault: state.target.name, path: rel, score: Math.round(best.score * 1000) / 1000, modified: entry.modified, snippet: best.preview });
        }
      }
      results.sort((a, b) => b.score - a.score);
      const remaining = states.reduce((sum, state) => sum + Math.max(0, state.remaining), 0);
      return {
        language: chosen,
        ...(remaining ? { still_indexing: remaining, note: "The first search of a large vault indexes it in steps. Search again to cover the rest." } : {}),
        notes: results.slice(0, Math.min(Math.max(Number(limit) || 10, 1), 50)),
      };
    },
  };
}
