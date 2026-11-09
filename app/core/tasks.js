// Personal task manager. SMCP.app is the only writer, so every client sees one list.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY = 86_400_000;
const MAX_NAME = 300;
const MAX_NOTE = 50_000;

export function defaultTasksPath() {
  return join(homedir(), ".smcp", "tasks.json");
}

const nfc = (value) => String(value ?? "").normalize("NFC").trim();
const fold = (value) => nfc(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function parseDate(value, label, endOfDay = false) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T${endOfDay ? "23:59:00" : "08:00:00"}` : text);
  if (Number.isNaN(date.getTime()) || !isRealCalendarDay(text)) throw new Error(`La fecha de ${label} no es válida. Usa AAAA-MM-DD.`);
  return date.toISOString();
}

/** The date parser turns February 31 into March 3, so check the day exists. */
function isRealCalendarDay(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return true;
  const [, year, month, day] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

/** Calendar day in this computer's time zone; ISO slices would shift evening dates by a day. */
function localDay(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_000) throw new Error("La estimación debe ser un número de minutos.");
  return minutes;
}

/** Next date for a simple iCalendar rule such as FREQ=WEEKLY;INTERVAL=2, or null if unsupported. */
export function nextOccurrence(rule, from) {
  const parts = Object.fromEntries(String(rule ?? "").split(";").map((piece) => piece.split("=")));
  const interval = Math.max(Number(parts.INTERVAL) || 1, 1);
  const next = new Date(from);
  if (parts.FREQ === "DAILY") next.setDate(next.getDate() + interval);
  else if (parts.FREQ === "WEEKLY") next.setDate(next.getDate() + 7 * interval);
  else if (parts.FREQ === "MONTHLY") addMonths(next, interval);
  else if (parts.FREQ === "YEARLY") addMonths(next, 12 * interval);
  else return null;
  return next.toISOString();
}

/** Stays in the target month: January 31 plus one month is the last day of February. */
function addMonths(date, months) {
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
}

export const CLAUDE_TAG = "🤖 Claude";

function emptyState() {
  return { version: 1, tasks: {}, projects: {}, tags: {} };
}

export function createTaskStore({ path = defaultTasksPath(), now = () => Date.now() } = {}) {
  let state = emptyState();
  if (existsSync(path)) {
    try {
      state = { ...emptyState(), ...JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      // Refusing to start empty protects a damaged file from being overwritten.
      throw new Error("No se pudo leer la lista de tareas. Restaura el respaldo tasks.json.bak.");
    }
  }

  const nowIso = () => new Date(now()).toISOString();

  // Anyone can assign work to Claude, even with a brand-new list.
  if (!Object.keys(state.tags).some((key) => fold(key).includes("claude"))) state.tags[CLAUDE_TAG] = { parent: null };

  const save = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const backup = `${path}.bak`;
    // One backup per day: a bad batch of edits cannot erase yesterday's list.
    if (existsSync(path) && (!existsSync(backup) || now() - statSync(backup).mtimeMs > DAY)) {
      copyFileSync(path, backup);
    }
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path);
  };

  const projectKey = (name) => Object.keys(state.projects).find((key) => fold(key) === fold(name));
  const tagKey = (name) => Object.keys(state.tags).find((key) => fold(key) === fold(name));

  const isWaitingRoot = (name) => fold(name).includes("esperando");
  const isWaitingTag = (name) => {
    const parent = state.tags[name]?.parent;
    return Boolean(parent && isWaitingRoot(parent));
  };
  const hasTag = (task, fragment) => (task.tags ?? []).some((tag) => fold(tag).includes(fragment));
  // A whole word, or "Comité" and "Smith" would count as most important tasks.
  const isMit = (task) => (task.tags ?? []).some((tag) => /(^|[^\p{L}\p{N}])mit($|[^\p{L}\p{N}])/u.test(fold(tag)));
  const waitingPerson = (task) => (task.tags ?? []).find(isWaitingTag) ?? null;
  const isWaiting = (task) => Boolean(waitingPerson(task)) || (task.tags ?? []).some(isWaitingRoot);
  const isOpen = (task) => !task.completedAt && !task.droppedAt;

  const projectBlocked = (task) => {
    const status = task.project ? state.projects[task.project]?.status : null;
    return status === "onhold" || status === "dropped";
  };
  const inDroppedProject = (task) => Boolean(task.project) && state.projects[task.project]?.status === "dropped";
  const isAvailable = (task) => isOpen(task) && !projectBlocked(task) && (!task.defer || new Date(task.defer).getTime() <= now());

  const waitingSince = (task) => {
    const promised = (task.note ?? "").match(/Prometido:\s*(\d{4}-\d{2}-\d{2})/);
    if (promised) return new Date(`${promised[1]}T08:00:00`);
    return task.createdAt ? new Date(task.createdAt) : null;
  };

  const score = (task) => {
    const endOfToday = new Date(now());
    endOfToday.setHours(23, 59, 59, 999);
    let value = 0;
    if (task.due) {
      const due = new Date(task.due).getTime();
      value += due <= endOfToday.getTime() ? 100 : 40 - Math.min(30, (due - now()) / DAY);
    }
    if (isMit(task)) value += 50;
    if (task.flagged) value += 25;
    if (hasTag(task, "algun dia")) value -= 100;
    return value;
  };

  const row = (task) => ({
    id: task.id,
    n: task.name,
    p: task.project ?? "INBOX",
    min: task.estimatedMinutes ?? null,
    due: task.due ? localDay(task.due) : null,
    defer: task.defer ? localDay(task.defer) : null,
    planned: task.planned ? localDay(task.planned) : null,
    dueAt: task.due ?? null,
    deferAt: task.defer ?? null,
    plannedAt: task.planned ?? null,
    repeat: task.repeat ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    status: task.droppedAt ? "dropped" : task.completedAt ? "done" : "active",
    available: isAvailable(task),
    flag: Boolean(task.flagged),
    mit: isMit(task),
    claude: hasTag(task, "claude"),
    energia: (task.tags ?? []).find((tag) => ["profundo", "rapido", "rutina"].some((word) => fold(tag).includes(word))) ?? null,
    tags: task.tags ?? [],
    note: task.note ?? "",
    done: Boolean(task.completedAt),
  });

  const need = (id) => {
    // hasOwn, or an id like "__proto__" would return the prototype of every object.
    if (!Object.hasOwn(state.tasks, String(id))) throw new Error("No existe esa tarea. Búscala con tasks_search.");
    return state.tasks[id];
  };

  const resolveProject = (name) => {
    if (name === null || name === undefined || name === "" || fold(name) === "inbox") return null;
    const key = projectKey(name);
    if (!key) throw new Error(`No existe el proyecto "${nfc(name)}". Consulta tasks_list_projects.`);
    return key;
  };

  const resolveTags = (tags, waitingFor) => {
    const resolved = [];
    for (const tag of tags ?? []) {
      const key = tagKey(tag);
      if (!key) throw new Error(`No existe el tag "${nfc(tag)}". Consulta tasks_list_projects.`);
      if (!resolved.includes(key)) resolved.push(key);
    }
    if (waitingFor) {
      const person = nfc(waitingFor).slice(0, 80);
      let key = tagKey(person);
      if (!key) {
        const root = Object.keys(state.tags).find(isWaitingRoot) ?? "⏳ Esperando a";
        state.tags[root] ??= { parent: null };
        state.tags[person] = { parent: root };
        key = person;
      }
      if (!resolved.includes(key)) resolved.push(key);
    }
    return resolved;
  };

  /** The owner is a tag, so it travels with the task and existing filters keep working. */
  const withOwner = (tags, forClaude) => {
    if (forClaude === undefined || forClaude === null) return tags;
    const key = Object.keys(state.tags).find((name) => fold(name).includes("claude"));
    const rest = tags.filter((tag) => tag !== key);
    return forClaude ? [...rest, key] : rest;
  };

  const cleanName = (name) => {
    const clean = nfc(name);
    if (!clean) throw new Error("La tarea necesita un nombre.");
    return clean.slice(0, MAX_NAME);
  };

  const available = () => {
    const live = Object.values(state.tasks).filter(isAvailable);
    const ranked = live.filter((task) => !isWaiting(task)).sort((a, b) => score(b) - score(a));
    const waiting = live
      .filter(isWaiting)
      .map((task) => {
        const since = waitingSince(task);
        return {
          ...row(task),
          quien: waitingPerson(task),
          desde: since ? localDay(since) : null,
          diasEsperando: since ? Math.round((now() - since.getTime()) / DAY) : null,
        };
      })
      .sort((a, b) => (b.diasEsperando ?? 0) - (a.diasEsperando ?? 0));
    return {
      generado: nowIso(),
      totalAccionables: ranked.length,
      minutosTotales: ranked.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0),
      sinEstimacion: ranked.filter((task) => !task.estimatedMinutes).map((task) => task.name),
      accionables: ranked.map(row),
      esperando: waiting,
    };
  };

  const api = {
    available,

    list({ view = "available" } = {}) {
      const tasks = Object.values(state.tasks);
      const byUpdated = (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      if (view === "available") return available().accionables;
      if (view === "waiting") return available().esperando;
      if (view === "inbox") return tasks.filter((task) => isOpen(task) && !task.project).sort(byUpdated).map(row);
      if (view === "deferred") {
        return tasks
          .filter((task) => isOpen(task) && !isAvailable(task))
          .sort((a, b) => (a.defer ?? "").localeCompare(b.defer ?? ""))
          .map(row);
      }
      if (view === "all") return tasks.filter(isOpen).sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "")).map(row);
      if (view === "done") return tasks.filter((task) => task.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 100).map(row);
      throw new Error("Vista desconocida.");
    },

    /** Sidebar data: folders with their projects, tags as a tree, and open counts. */
    catalog() {
      const open = Object.values(state.tasks).filter(isOpen);
      const projectCounts = {};
      const tagCounts = {};
      for (const task of open) {
        if (task.project) {
          const entry = (projectCounts[task.project] ??= { open: 0, available: 0 });
          entry.open += 1;
          if (isAvailable(task)) entry.available += 1;
        }
        for (const tag of task.tags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      const folders = {};
      for (const [name, project] of Object.entries(state.projects)) {
        (folders[project.folder ?? "Sin carpeta"] ??= []).push({
          name,
          status: project.status ?? "active",
          reviewDays: project.reviewDays ?? null,
          nextReview: project.nextReview ?? null,
          lastReviewed: project.lastReviewed ?? null,
          ...(projectCounts[name] ?? { open: 0, available: 0 }),
        });
      }
      const tags = Object.entries(state.tags).map(([name, tag]) => ({ name, parent: tag.parent ?? null, open: tagCounts[name] ?? 0 }));
      const dueNow = Object.values(state.projects).filter((project) => (project.status ?? "active") === "active" && project.nextReview && new Date(project.nextReview).getTime() <= now()).length;
      const startOfToday = new Date(now());
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = startOfToday.getTime() + DAY;
      return {
        folders,
        tags,
        counts: {
          inbox: open.filter((task) => !task.project).length,
          flagged: open.filter((task) => task.flagged && isAvailable(task)).length,
          forecast: open.filter((task) => !inDroppedProject(task) && task.due && new Date(task.due).getTime() < endOfToday).length,
          review: dueNow,
        },
      };
    },

    /** Everything the main list can show, by section. */
    query({ kind, value } = {}) {
      const open = Object.values(state.tasks).filter(isOpen);
      const ordered = (list) => list.sort((a, b) => score(b) - score(a) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).map(row);
      const childrenOf = (name) => Object.entries(state.tags).filter(([, tag]) => tag.parent === name).map(([key]) => key);
      switch (kind) {
        case "inbox":
          return ordered(open.filter((task) => !task.project));
        case "flagged":
          return ordered(open.filter((task) => task.flagged && isAvailable(task)));
        case "project":
          return ordered(open.filter((task) => task.project === value));
        case "tag": {
          const names = new Set([value, ...childrenOf(value)]);
          return ordered(open.filter((task) => (task.tags ?? []).some((tag) => names.has(tag))));
        }
        case "hoy": {
          const end = new Date(now());
          end.setHours(23, 59, 59, 999);
          return ordered(open.filter((task) => isAvailable(task) && (task.flagged || (task.due && new Date(task.due) <= end) || (task.planned && new Date(task.planned) <= end))));
        }
        case "deep":
          return ordered(open.filter((task) => isAvailable(task) && hasTag(task, "profundo")));
        case "quick":
          return ordered(open.filter((task) => isAvailable(task) && hasTag(task, "rapido")));
        case "waiting":
          return available().esperando;
        case "claude":
          return ordered(open.filter((task) => isAvailable(task) && !isWaiting(task) && hasTag(task, "claude")));
        case "agenda":
          return ordered(open.filter((task) => isAvailable(task) && hasTag(task, "agenda")));
        case "available":
          return available().accionables;
        case "archive":
          return Object.values(state.tasks).filter((task) => task.droppedAt).sort((a, b) => b.droppedAt.localeCompare(a.droppedAt)).slice(0, 500).map(row);
        case "completed":
          return Object.values(state.tasks).filter((task) => task.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 200).map(row);
        default:
          throw new Error("Vista desconocida.");
      }
    },

    /** Open items by calendar day: anything overdue under past, then a window of days, then future. */
    forecast({ days = 60 } = {}) {
      const open = Object.values(state.tasks).filter((task) => isOpen(task) && !inDroppedProject(task));
      const today = localDay(now());
      const start = new Date(`${today}T00:00:00`);
      const keys = Array.from({ length: Math.min(Math.max(Number(days) || 60, 1), 370) }, (_, index) => {
        const day = new Date(start);
        day.setDate(day.getDate() + index);
        return localDay(day);
      });
      const inWindow = new Set(keys);
      const buckets = Object.fromEntries(keys.map((key) => [key, []]));
      const past = [];
      const future = [];
      for (const task of open) {
        const dueDay = task.due ? localDay(task.due) : null;
        const plannedDay = task.planned ? localDay(task.planned) : null;
        const day = [dueDay, plannedDay].filter(Boolean).sort()[0];
        if (!day) continue;
        if (dueDay && dueDay < today) past.push(task);
        else if (inWindow.has(dueDay)) buckets[dueDay].push(task);
        // A plan that slipped is not overdue, but it is still pending: it stays on today.
        else if (plannedDay && plannedDay < today) buckets[today].push(task);
        else if (inWindow.has(plannedDay)) buckets[plannedDay].push(task);
        else if (day > keys.at(-1)) future.push(task);
      }
      const byDate = (a, b) => (a.due ?? a.planned ?? "").localeCompare(b.due ?? b.planned ?? "");
      return {
        today,
        past: past.sort(byDate).map(row),
        days: keys.map((date) => ({ date, tasks: buckets[date].sort(byDate).map(row) })),
        future: future.length,
      };
    },

    reviewList() {
      return Object.entries(state.projects)
        .filter(([, project]) => (project.status ?? "active") === "active" && project.nextReview && new Date(project.nextReview).getTime() <= now())
        .map(([name, project]) => ({ name, folder: project.folder ?? "Sin carpeta", nextReview: localDay(project.nextReview), reviewDays: project.reviewDays ?? null, lastReviewed: project.lastReviewed ? localDay(project.lastReviewed) : null }))
        .sort((a, b) => a.nextReview.localeCompare(b.nextReview));
    },

    markReviewed({ name }) {
      const key = projectKey(name);
      if (!key) throw new Error("No existe ese proyecto.");
      const project = state.projects[key];
      project.lastReviewed = nowIso();
      project.nextReview = new Date(now() + (project.reviewDays ?? 7) * DAY).toISOString();
      save();
      return { name: key, nextReview: localDay(project.nextReview) };
    },

    updateProject({ name, rename, folder, status, review_days: reviewDays }) {
      const key = projectKey(name);
      if (!key) throw new Error("No existe ese proyecto.");
      const project = state.projects[key];
      // Everything is checked first, so a rejected edit changes nothing.
      if (status !== undefined && !["active", "onhold", "dropped"].includes(status)) throw new Error("Estado inválido.");
      const interval = reviewDays === undefined || reviewDays === null ? reviewDays : Number(reviewDays);
      if (interval !== undefined && interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 366)) {
        throw new Error("El intervalo debe ser de 1 a 366 días.");
      }
      const clean = rename === undefined ? key : cleanName(rename);
      if (projectKey(clean) && projectKey(clean) !== key) throw new Error("Ya existe un proyecto con ese nombre.");

      if (folder !== undefined) project.folder = nfc(folder) || "Sin carpeta";
      if (status !== undefined) project.status = status;
      if (interval !== undefined) {
        project.reviewDays = interval;
        if (interval && !project.nextReview) project.nextReview = new Date(now() + interval * DAY).toISOString();
      }
      if (clean !== key) {
        state.projects[clean] = project;
        delete state.projects[key];
        for (const task of Object.values(state.tasks)) if (task.project === key) task.project = clean;
      }
      save();
      return { name: clean };
    },

    summary() {
      const data = available();
      const inbox = Object.values(state.tasks).filter((task) => isOpen(task) && !task.project).length;
      return { available: data.totalAccionables, minutes: data.minutosTotales, waiting: data.esperando.length, inbox };
    },

    /** Accent-insensitive; every word must appear in the name or the note. */
    search({ query, include_done: includeDone = false, limit = 20 }) {
      const terms = fold(query).split(/\s+/).filter(Boolean);
      if (!terms.length) throw new Error("Escribe qué buscar.");
      const matches = Object.values(state.tasks).filter((task) => {
        if (task.droppedAt || inDroppedProject(task) || (!includeDone && task.completedAt)) return false;
        const text = fold(`${task.name} ${task.note ?? ""}`);
        return terms.every((term) => text.includes(term));
      });
      return { total: matches.length, tareas: matches.slice(0, Math.min(Number(limit) || 20, 100)).map(row) };
    },

    claudeQueue() {
      return Object.values(state.tasks)
        .filter((task) => isAvailable(task) && !isWaiting(task) && hasTag(task, "claude"))
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.estimatedMinutes ?? 9999) - (b.estimatedMinutes ?? 9999))
        .map(row);
    },

    listProjects() {
      const folders = {};
      for (const [name, project] of Object.entries(state.projects)) {
        (folders[project.folder ?? "Sin carpeta"] ??= []).push({ name, status: project.status ?? "active" });
      }
      return { folders, tags: Object.entries(state.tags).map(([name, tag]) => ({ name, parent: tag.parent ?? null })) };
    },

    createProject({ name, folder, status = "active" }) {
      const clean = cleanName(name);
      if (projectKey(clean)) throw new Error("Ese proyecto ya existe.");
      if (!["active", "onhold", "dropped"].includes(status)) throw new Error("Estado inválido.");
      state.projects[clean] = { folder: nfc(folder) || "Sin carpeta", status };
      save();
      return { name: clean };
    },

    createTag({ name, parent = null }) {
      const clean = cleanName(name);
      if (tagKey(clean)) throw new Error("Ese tag ya existe.");
      state.tags[clean] = { parent: parent ? tagKey(parent) ?? null : null };
      save();
      return { name: clean };
    },

    create({ name, note, project, tags, waiting_for: waitingFor, due, defer, planned, estimated_minutes: minutes, flagged, repeat, for_claude: forClaude }) {
      const checked = {
        name: cleanName(name),
        project: resolveProject(project),
        due: parseDate(due, "límite", true),
        defer: parseDate(defer, "inicio"),
        planned: parseDate(planned, "planeado"),
        estimatedMinutes: parseMinutes(minutes),
      };
      const task = {
        id: randomUUID(),
        ...checked,
        note: String(note ?? "").slice(0, MAX_NOTE),
        // Last, because waiting_for can add a tag: it must not stay behind if the task was rejected.
        tags: withOwner(resolveTags(tags, waitingFor), forClaude),
        flagged: Boolean(flagged),
        repeat: repeat ? String(repeat).slice(0, 120) : null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        completedAt: null,
        droppedAt: null,
      };
      state.tasks[task.id] = task;
      save();
      return row(task);
    },

    update({ id, name, note, project, tags, waiting_for: waitingFor, due, defer, planned, estimated_minutes: minutes, flagged, repeat, for_claude: forClaude }) {
      const task = need(id);
      // Built apart and applied at the end, so a rejected edit changes nothing.
      const changes = {};
      if (name !== undefined) changes.name = cleanName(name);
      if (note !== undefined) changes.note = String(note ?? "").slice(0, MAX_NOTE);
      if (project !== undefined) changes.project = resolveProject(project);
      if (planned !== undefined) changes.planned = parseDate(planned, "planeado");
      if (repeat !== undefined) changes.repeat = repeat ? String(repeat).slice(0, 120) : null;
      if (due !== undefined) changes.due = parseDate(due, "límite", true);
      if (defer !== undefined) changes.defer = parseDate(defer, "inicio");
      if (minutes !== undefined) changes.estimatedMinutes = parseMinutes(minutes);
      if (flagged !== undefined) changes.flagged = Boolean(flagged);
      // Last, because waiting_for can add a tag: it must not stay behind if the edit was rejected.
      if (tags !== undefined || waitingFor !== undefined) changes.tags = resolveTags(tags ?? task.tags, waitingFor);
      if (forClaude !== undefined) changes.tags = withOwner(changes.tags ?? task.tags, forClaude);
      Object.assign(task, changes, { updatedAt: nowIso() });
      save();
      return row(task);
    },

    appendNote({ id, text }) {
      const task = need(id);
      const addition = String(text ?? "").trim();
      if (!addition) throw new Error("La nota está vacía.");
      task.note = `${task.note ? `${task.note}\n\n` : ""}${addition}`.slice(0, MAX_NOTE);
      task.updatedAt = nowIso();
      save();
      return row(task);
    },

    complete({ id }) {
      const task = need(id);
      if (task.completedAt) return row(task);
      task.completedAt = nowIso();
      task.updatedAt = nowIso();
      if (task.repeat) {
        const base = task.due ?? task.defer ?? task.completedAt;
        const next = nextOccurrence(task.repeat, base);
        if (next) {
          const shift = new Date(next).getTime() - new Date(base).getTime();
          const copy = {
            ...task,
            id: randomUUID(),
            due: task.due ? new Date(new Date(task.due).getTime() + shift).toISOString() : null,
            defer: task.defer ? new Date(new Date(task.defer).getTime() + shift).toISOString() : null,
            planned: task.planned ? new Date(new Date(task.planned).getTime() + shift).toISOString() : null,
            createdAt: task.completedAt,
            updatedAt: task.completedAt,
            completedAt: null,
          };
          state.tasks[copy.id] = copy;
          task.nextId = copy.id; // Lets "undo" take this occurrence back.
        }
      }
      save();
      return row(task);
    },

    get({ id }) {
      return row(need(id));
    },

    /**
     * Clears the whole list in one reversible step. Local only on purpose: it is never
     * offered to other computers or to the AI tools.
     */
    archiveAll() {
      const batch = nowIso();
      let tasks = 0;
      let projects = 0;
      for (const task of Object.values(state.tasks)) {
        if (!isOpen(task)) continue;
        task.droppedAt = batch;
        task.archivedBatch = batch;
        tasks += 1;
      }
      for (const project of Object.values(state.projects)) {
        if ((project.status ?? "active") === "dropped") continue;
        project.statusBeforeArchive = project.status ?? "active";
        project.status = "dropped";
        project.archivedBatch = batch;
        projects += 1;
      }
      save();
      return { batch, tasks, projects };
    },

    restoreProject({ name }) {
      const key = projectKey(name);
      if (!key) throw new Error("No existe ese proyecto.");
      const project = state.projects[key];
      project.status = project.statusBeforeArchive ?? "active";
      delete project.statusBeforeArchive;
      delete project.archivedBatch;
      save();
      return { name: key };
    },

    reopen({ id }) {
      const task = need(id);
      // Undoing a repeat removes the next occurrence, unless someone has already worked on it.
      const next = task.nextId ? state.tasks[task.nextId] : null;
      if (task.completedAt && next && isOpen(next) && next.updatedAt === next.createdAt) delete state.tasks[task.nextId];
      delete task.nextId;
      task.completedAt = null;
      task.droppedAt = null;
      delete task.archivedBatch;
      // A task restored from the archive brings its project back, or it would be invisible.
      const project = task.project ? state.projects[task.project] : null;
      if (project?.archivedBatch) {
        project.status = project.statusBeforeArchive ?? "active";
        delete project.statusBeforeArchive;
        delete project.archivedBatch;
      }
      task.updatedAt = nowIso();
      save();
      return row(task);
    },

    drop({ id }) {
      const task = need(id);
      task.droppedAt = nowIso();
      task.updatedAt = nowIso();
      save();
      return { dropped: true, id };
    },

    hygiene() {
      const days = (iso) => (now() - new Date(iso).getTime()) / DAY;
      const open = Object.values(state.tasks).filter(isOpen);
      const live = open.filter((task) => isAvailable(task) && !hasTag(task, "algun dia"));
      const brief = (task) => ({ id: task.id, n: task.name, p: task.project ?? "INBOX" });
      const zombies = live
        .filter((task) => !isWaiting(task) && !task.due && days(task.updatedAt) > 30)
        .map((task) => ({ ...brief(task), diasSinTocar: Math.round(days(task.updatedAt)) }))
        .sort((a, b) => b.diasSinTocar - a.diasSinTocar);
      const waiting = live.filter(isWaiting);
      const esperasViejas = waiting
        .filter((task) => waitingSince(task) && (now() - waitingSince(task).getTime()) / DAY > 30)
        .map((task) => ({
          ...brief(task),
          quien: waitingPerson(task),
          desde: localDay(waitingSince(task)),
          diasEsperando: Math.round((now() - waitingSince(task).getTime()) / DAY),
        }))
        .sort((a, b) => b.diasEsperando - a.diasEsperando);

      const proyectosSinAccion = [];
      const proyectosDiferidos = [];
      const balance = {};
      const bucket = (folder) => (balance[folder] ??= { proyectos: 0, abiertas: 0, completadas30: 0 });
      for (const [name, project] of Object.entries(state.projects)) {
        if ((project.status ?? "active") !== "active") continue;
        bucket(project.folder ?? "Sin carpeta").proyectos += 1;
        const mine = open.filter((task) => task.project === name);
        if (mine.some(isAvailable)) continue;
        const nextDefer = mine.map((task) => task.defer).filter(Boolean).sort()[0];
        const item = { n: name, carpeta: project.folder ?? "Sin carpeta", abiertas: mine.length };
        if (nextDefer) proyectosDiferidos.push({ ...item, disponibleDesde: localDay(nextDefer) });
        else proyectosSinAccion.push(item);
      }
      const folderOf = (task) => (task.project ? state.projects[task.project]?.folder ?? "Sin carpeta" : "Sin carpeta");
      for (const task of open) bucket(folderOf(task)).abiertas += 1;
      for (const task of Object.values(state.tasks)) {
        if (task.completedAt && days(task.completedAt) <= 30) bucket(folderOf(task)).completadas30 += 1;
      }
      return {
        generado: nowIso(),
        colaDisponible: available().totalAccionables,
        zombies,
        esperasVivas: waiting.length,
        esperasViejas,
        proyectosSinAccion,
        proyectosDiferidos,
        balancePorDominio: balance,
        dominiosSinActividad30d: Object.keys(balance).filter((folder) => balance[folder].completadas30 === 0),
      };
    },

    /** Idempotent by OmniFocus id: importing twice updates instead of duplicating. */
    importOmniFocus({ projects = [], tags = [], tasks = [], schemaOnly = false }) {
      if (schemaOnly) {
        // Adds fields a first import lacked, without touching anything edited since.
        const byOfId = new Map(Object.values(state.tasks).filter((task) => task.ofId).map((task) => [task.ofId, task]));
        let projectsUpdated = 0;
        let tasksUpdated = 0;
        for (const item of projects) {
          const target = state.projects[nfc(item.name)];
          if (!target) continue;
          target.reviewDays = item.reviewDays ?? target.reviewDays ?? null;
          target.nextReview = item.nextReview ?? target.nextReview ?? null;
          target.lastReviewed = item.lastReviewed ?? target.lastReviewed ?? null;
          projectsUpdated += 1;
        }
        for (const item of tasks) {
          const target = byOfId.get(item.ofId);
          if (target && item.planned && !target.planned) {
            target.planned = item.planned;
            tasksUpdated += 1;
          }
        }
        save();
        return { schemaOnly: true, projectsUpdated, tasksUpdated };
      }
      for (const project of projects) {
        const name = nfc(project.name);
        if (name) {
          state.projects[name] = {
            folder: nfc(project.folder) || "Sin carpeta",
            status: ["active", "onhold", "dropped"].includes(project.status) ? project.status : "active",
            reviewDays: project.reviewDays ?? null,
            nextReview: project.nextReview ?? null,
            lastReviewed: project.lastReviewed ?? null,
          };
        }
      }
      for (const tag of tags) {
        const name = nfc(tag.name);
        if (name) state.tags[name] = { parent: tag.parent ? nfc(tag.parent) : null };
      }
      const known = new Map(Object.values(state.tasks).filter((task) => task.ofId).map((task) => [task.ofId, task]));
      let created = 0;
      let updated = 0;
      for (const item of tasks) {
        const existing = known.get(item.ofId);
        const task = existing ?? { id: randomUUID(), ofId: item.ofId };
        Object.assign(task, {
          name: cleanName(item.name),
          note: String(item.note ?? "").normalize("NFC").slice(0, MAX_NOTE),
          project: item.project ? nfc(item.project) : null,
          tags: (item.tags ?? []).map(nfc),
          due: item.due ?? null,
          defer: item.defer ?? null,
          planned: item.planned ?? null,
          estimatedMinutes: item.estimatedMinutes ?? null,
          flagged: Boolean(item.flagged),
          repeat: item.repeat ?? null,
          createdAt: item.createdAt ?? nowIso(),
          updatedAt: item.updatedAt ?? nowIso(),
          completedAt: item.completedAt ?? null,
          droppedAt: item.droppedAt ?? null,
        });
        state.tasks[task.id] = task;
        if (existing) updated += 1;
        else created += 1;
      }
      save();
      return { created, updated, totalTasks: Object.keys(state.tasks).length, projects: Object.keys(state.projects).length, tags: Object.keys(state.tags).length };
    },
  };
  return api;
}

/** Operations other computers and the MCP server may call. */
export const TASK_OPERATIONS = [
  "available",
  "list",
  "summary",
  "search",
  "claudeQueue",
  "listProjects",
  "hygiene",
  "catalog",
  "get",
  "restoreProject",
  "query",
  "forecast",
  "reviewList",
  "markReviewed",
  "updateProject",
  "create",
  "createProject",
  "createTag",
  "update",
  "appendNote",
  "complete",
  "reopen",
  "drop",
];
