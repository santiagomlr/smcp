const $ = (id) => document.getElementById(id);

const SECTIONS = [
  ["today", "Hoy"],
  ["inbox", "Bandeja"],
  ["upcoming", "Próximo"],
];

const state = {
  section: "today",
  project: null,
  search: "",
  rows: [],
  groups: null,
  catalog: { folders: {}, tags: [], counts: {} },
  selected: null,
  detail: null,
  calendar: "ask",
  key: null,
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function showError(message) {
  $("error").textContent = message || "";
  $("error").hidden = !message;
  if (message) setTimeout(() => ($("error").hidden = true), 6000);
}

async function call(op, args) {
  const result = await api.tasks(op, args);
  if (!result.ok) {
    showError(result.error);
    return null;
  }
  showError("");
  return result.value;
}

/* Dates */

const pad = (number) => String(number).padStart(2, "0");
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const todayKey = () => dayKey(new Date());
const fromKey = (key) => new Date(`${key}T12:00:00`);

function friendlyDay(key) {
  const today = todayKey();
  if (key === today) return "Hoy";
  if (key === dayKey(addDays(new Date(), 1))) return "Mañana";
  if (key === dayKey(addDays(new Date(), -1))) return "Ayer";
  return fromKey(key).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

const dateTimeInput = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/* Sidebar */

function projects() {
  return Object.values(state.catalog.folders).flat().filter((project) => project.status !== "dropped");
}

function sideRow(label, count, active, onclick, className = "") {
  const row = el("button", { type: "button", className: `side-row ${className}`, onclick, title: label }, el("span", { className: "name", textContent: label }), count ? el("span", { className: "count", textContent: String(count) }) : null);
  row.setAttribute("aria-current", String(active));
  return row;
}

function renderSide() {
  const counts = state.catalog.counts;
  const countOf = { today: state.catalog.today, inbox: counts.inbox };
  $("side-main").replaceChildren(...SECTIONS.map(([id, label]) => sideRow(label, countOf[id], state.section === id && !state.search, () => go(id))));
  const list = projects();
  $("side-projects").replaceChildren(
    ...(list.length
      ? list.map((project) => sideRow(project.name, project.open, state.section === "project" && state.project === project.name && !state.search, () => go("project", project.name), project.status === "onhold" ? "paused" : ""))
      : [el("div", { className: "side-hint", textContent: "Crea tu primer proyecto" })]),
  );
  $("side-foot").replaceChildren(sideRow("Hechas", null, state.section === "done", () => go("done")), sideRow("Archivo", null, state.section === "archive", () => go("archive")));
}

/* List */

function whenControl(task) {
  const late = task.due && task.due < todayKey();
  const input = el("input", { type: "date", value: task.due ?? "", tabIndex: -1 });
  input.setAttribute("aria-label", "Fecha límite");
  input.onchange = () => update(task.id, { due: input.value || null });
  const button = el("button", {
    type: "button",
    className: `${task.due ? "" : "none"}${late ? " late" : ""}`,
    textContent: task.due ? friendlyDay(task.due) : "Fecha",
    onclick: (event) => {
      event.stopPropagation();
      input.showPicker();
    },
  });
  return el("div", { className: "when" }, button, input);
}

function row(task, { where = false } = {}) {
  const check = el("button", { type: "button", className: "check" });
  check.setAttribute("aria-label", `${task.status === "done" ? "Reabrir" : "Completar"} ${task.n}`);
  const name = el(
    "button",
    { type: "button", className: "row-name", onclick: () => select(task) },
    el("span", { textContent: task.n }),
    where && task.p !== "INBOX" ? el("span", { className: "where", textContent: task.p }) : null,
  );
  const who = el("button", {
    type: "button",
    className: `who${task.claude ? " claude" : ""}`,
    textContent: task.claude ? "Claude" : "Yo",
    title: "Cambiar quién la hace",
    onclick: () => update(task.id, { for_claude: !task.claude }),
  });
  const node = el("div", { className: `row${task.id === state.selected ? " selected" : ""}${task.status === "done" ? " done" : ""}` }, check, name, who, whenControl(task));
  node.dataset.id = task.id;
  check.onclick = async () => {
    check.disabled = true;
    if (task.status === "done") {
      await call("reopen", { id: task.id });
    } else {
      node.classList.add("leaving");
      if (await call("complete", { id: task.id })) toast("Completada", task.id);
      else node.classList.remove("leaving");
      await new Promise((resolve) => setTimeout(resolve, 240));
    }
    if (state.selected === task.id) closeDetail();
    await load(true);
  };
  return node;
}

function archivedRow(task) {
  const restore = el("button", {
    type: "button",
    className: "restore",
    textContent: "Restaurar",
    onclick: async () => {
      if (await call("reopen", { id: task.id })) toast("Restaurada");
      await load(true);
    },
  });
  return el("div", { className: "row compact" }, el("span"), el("div", { className: "row-name" }, el("span", { textContent: task.n }), task.p !== "INBOX" ? el("span", { className: "where", textContent: task.p }) : null), restore);
}

function archivedProjects() {
  return Object.values(state.catalog.folders).flat().filter((project) => project.status === "dropped");
}

function archivedProjectRow(project) {
  const restore = el("button", {
    type: "button",
    className: "restore",
    textContent: "Restaurar",
    onclick: async () => {
      if (await call("restoreProject", { name: project.name })) toast("Proyecto restaurado");
      await load(true);
    },
  });
  return el("div", { className: "row compact" }, el("span"), el("div", { className: "row-name" }, el("span", { textContent: project.name }), el("span", { className: "where", textContent: "Proyecto" })), restore);
}

function eventRow(event) {
  const label = event.allDay ? "Todo el día" : new Date(event.start).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
  return el("div", { className: "event" }, el("time", { textContent: label }), el("span", { textContent: event.title }));
}

function renderList() {
  const list = $("list");
  const nodes = [];
  if (state.groups) {
    for (const group of state.groups) {
      if (!group.tasks.length && !group.events?.length) continue;
      nodes.push(el("div", { className: "group-title", textContent: group.title }), ...(group.events ?? []).map(eventRow), ...group.tasks.map((task) => row(task, { where: true })));
    }
  } else if (state.section === "archive" && !state.search) {
    nodes.push(...archivedProjects().map(archivedProjectRow), ...state.rows.map(archivedRow));
  } else {
    nodes.push(...state.rows.map((task) => row(task, { where: state.section !== "project" })));
  }
  if (state.section === "upcoming" && !state.search && ["ask", "denied"].includes(state.calendar)) {
    const asking = state.calendar === "ask";
    nodes.unshift(
      el("button", {
        type: "button",
        className: "calendar-link quiet",
        textContent: asking ? "Mostrar mi calendario" : "Permitir el calendario en Ajustes",
        onclick: async () => {
          if (!asking) return api.openPrivacy("calendars");
          const result = await api.calendarRequest();
          if (!result.ok) return showError(result.error);
          state.calendar = result.value;
          await load(true);
        },
      }),
    );
  }
  list.replaceChildren(...nodes);

  const canAdd = !state.search && !["done", "archive"].includes(state.section);
  $("add").hidden = !canAdd;
  const empty = $("empty");
  const isEmpty = !nodes.some((node) => !node.classList.contains("calendar-link"));
  empty.hidden = !isEmpty;
  if (isEmpty) {
    const copy = { today: "Nada para hoy.", inbox: "Tu bandeja está vacía.", upcoming: "Nada programado.", project: "Agrega la primera tarea de este proyecto.", done: "Aún no hay tareas hechas.", archive: "El archivo está vacío." };
    empty.textContent = state.search ? "Sin resultados." : copy[state.section];
  }
}

function renderHead() {
  const title = $("title");
  const isProject = state.section === "project" && !state.search;
  title.readOnly = !isProject;
  if (document.activeElement !== title) {
    const names = { today: "Hoy", inbox: "Bandeja", upcoming: "Próximo", done: "Hechas", archive: "Archivo" };
    title.value = state.search ? `Buscar: ${state.search}` : isProject ? state.project : names[state.section];
  }
  $("project-actions").hidden = !isProject;
}

/* Data */

async function fetchView() {
  if (state.search) {
    const found = await call("search", { query: state.search, limit: 100 });
    return { rows: found?.tareas ?? [], groups: null };
  }
  const kinds = { today: { kind: "hoy" }, inbox: { kind: "inbox" }, done: { kind: "completed" }, archive: { kind: "archive" }, project: { kind: "project", value: state.project } };
  if (state.section !== "upcoming") {
    return { rows: (await call("query", kinds[state.section])) ?? [], groups: null };
  }
  const data = await call("forecast", { days: 30 });
  if (!data) return { rows: state.rows, groups: null };
  let events = [];
  if (state.calendar === "granted") {
    const start = fromKey(data.today);
    start.setHours(0, 0, 0, 0);
    const result = await api.calendarEvents(start.getTime(), start.getTime() + 30 * 86_400_000);
    if (result.ok) events = result.value.events;
  }
  const byDay = new Map();
  for (const event of events) {
    const key = dayKey(new Date(event.start));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(event);
  }
  const groups = [
    { title: "Vencidas", tasks: data.past },
    ...data.days.map((day) => ({
      title: fromKey(day.date).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }),
      tasks: day.tasks,
      events: byDay.get(day.date),
    })),
  ];
  return { rows: [], groups };
}

function editing() {
  return Boolean(document.activeElement?.closest?.("#drawer, #title:not([readonly])"));
}

let latestLoad = 0;
let renderOwed = false;

async function load(force = false) {
  if (!force && editing()) return;
  // With the list on another computer, answers can arrive out of order. Only the newest one counts.
  const thisLoad = ++latestLoad;
  renderOwed ||= force;
  const today = await api.tasks("query", { kind: "hoy" });
  const catalog = await api.tasks("catalog");
  if (thisLoad !== latestLoad) return;
  if (catalog.ok) state.catalog = { ...catalog.value, today: today.ok ? today.value.length : 0 };
  if (state.section === "project" && !projects().some((project) => project.name === state.project)) state.section = "today";
  const view = await fetchView();
  if (thisLoad !== latestLoad) return;
  state.rows = view.rows;
  state.groups = view.groups;
  const key = JSON.stringify([state.section, state.project, state.search, state.rows, state.groups, state.catalog, state.selected]);
  if (key === state.key && !renderOwed) return;
  renderOwed = false;
  state.key = key;
  renderSide();
  renderHead();
  renderList();
}

function go(section, project = null) {
  state.section = section;
  state.project = project;
  state.search = "";
  $("search").value = "";
  $("project-pop").hidden = true;
  $("scroll").scrollTop = 0;
  closeDetail();
  load(true);
}

async function update(id, fields) {
  const updated = await call("update", { id, ...fields });
  if (!updated) return;
  if (state.selected === id) {
    state.detail = updated;
    renderDetail();
  }
  await load(true);
}

/* Detail */

function closeDetail() {
  state.selected = null;
  state.detail = null;
  $("drawer").hidden = true;
  for (const node of document.querySelectorAll(".row.selected")) node.classList.remove("selected");
}

function select(task) {
  if (state.selected === task.id) return closeDetail();
  state.selected = task.id;
  state.detail = task;
  for (const node of document.querySelectorAll(".row")) node.classList.toggle("selected", node.dataset.id === task.id);
  renderDetail();
}

function field(label, control) {
  return el("label", { className: "field" }, label, control);
}

function dateField(label, key, value) {
  const input = el("input", { type: "datetime-local", value: dateTimeInput(value) });
  input.onchange = () => update(state.selected, { [key]: input.value ? new Date(input.value).toISOString() : null });
  return field(label, input);
}

function renderDetail() {
  const drawer = $("drawer");
  const task = state.detail;
  if (!task) {
    drawer.hidden = true;
    return;
  }
  const id = task.id;
  const name = el("textarea", { id: "detail-name", value: task.n, maxLength: 300, rows: 1 });
  name.onchange = () => name.value.trim() && update(id, { name: name.value });
  name.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    }
  };

  const seg = (value, label) => {
    const button = el("button", { type: "button", textContent: label, onclick: () => update(id, { for_claude: value === "claude" }) });
    button.setAttribute("aria-pressed", String(value === (task.claude ? "claude" : "me")));
    return button;
  };

  const project = el("select");
  project.append(el("option", { value: "", textContent: "Bandeja" }));
  for (const item of projects()) project.append(el("option", { value: item.name, textContent: item.name }));
  project.value = task.p === "INBOX" ? "" : task.p;
  if (project.value !== (task.p === "INBOX" ? "" : task.p)) project.append(el("option", { value: task.p, textContent: task.p, selected: true }));
  project.onchange = () => update(id, { project: project.value });

  const note = el("textarea", { value: task.note, placeholder: "Notas", maxLength: 50000 });
  note.onchange = () => update(id, { note: note.value });

  const minutes = el("input", { type: "number", min: 0, max: 10000, value: task.min ?? "", placeholder: "Sin estimar" });
  minutes.onchange = () => update(id, { estimated_minutes: minutes.value === "" ? null : Number(minutes.value) });

  const parts = Object.fromEntries(String(task.repeat ?? "").split(";").map((piece) => piece.split("=")));
  const repeat = el("select", {}, ...[["", "No se repite"], ["DAILY", "Cada día"], ["WEEKLY", "Cada semana"], ["MONTHLY", "Cada mes"], ["YEARLY", "Cada año"]].map(([value, textContent]) => el("option", { value, textContent })));
  repeat.value = parts.FREQ ?? "";
  repeat.onchange = () => update(id, { repeat: repeat.value ? `FREQ=${repeat.value};INTERVAL=${Number(parts.INTERVAL) || 1}` : null });

  const visibleTags = task.tags.filter((tag) => !/claude/i.test(tag));
  const addTag = el("select", {}, el("option", { value: "", textContent: "Agregar etiqueta" }), ...state.catalog.tags.filter((tag) => !task.tags.includes(tag.name) && !/claude/i.test(tag.name)).map((tag) => el("option", { value: tag.name, textContent: tag.name })));
  addTag.onchange = () => addTag.value && update(id, { tags: [...task.tags, addTag.value] });

  const flag = el("input", { type: "checkbox", className: "switch", checked: task.flag, onchange: (event) => update(id, { flagged: event.target.checked }) });

  const hasExtras = Boolean(task.deferAt || task.plannedAt || task.min || task.repeat || visibleTags.length || task.flag);
  const more = el(
    "details",
    { className: "more", open: hasExtras },
    el("summary", { textContent: "Más opciones" }),
    dateField("Empieza", "defer", task.deferAt),
    dateField("Planeada", "planned", task.plannedAt),
    field("Duración (minutos)", minutes),
    field("Repetir", repeat),
    el("div", { className: "field" }, "Etiquetas", el("div", { className: "tag-list" }, ...visibleTags.map((tag) => el("button", { type: "button", textContent: tag, onclick: () => update(id, { tags: task.tags.filter((item) => item !== tag) }) }))), addTag),
    el("label", { className: "field" }, "Importante", flag),
  );

  const archive = el("button", {
    type: "button",
    className: "quiet",
    textContent: "Archivar",
    onclick: async () => {
      if (await call("drop", { id })) toast("Archivada", id);
      closeDetail();
      await load(true);
    },
  });

  drawer.replaceChildren(
    name,
    el("div", { className: "field" }, "Quién la hace", el("div", { className: "seg" }, seg("me", "Yo"), seg("claude", "Claude"))),
    field("Proyecto", project),
    dateField("Vence", "due", task.dueAt),
    field("Notas", note),
    more,
    el("div", { className: "drawer-foot" }, archive),
  );
  drawer.hidden = false;
}

/* Toast */

let toastTimer = null;
function toast(text, undoId) {
  clearTimeout(toastTimer);
  $("toast-text").textContent = text;
  $("toast-undo").hidden = !undoId;
  $("toast-undo").onclick = async () => {
    $("toast").hidden = true;
    await call("reopen", { id: undoId });
    await load(true);
  };
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}

/* Actions */

$("add").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("add-name");
  const name = input.value.trim();
  if (!name) return;
  const args = { name };
  if (state.section === "project") args.project = state.project;
  if (state.section === "today" || state.section === "upcoming") args.planned = todayKey();
  if (!(await call("create", args))) return;
  input.value = "";
  await load(true);
  $("scroll").scrollTop = $("scroll").scrollHeight;
};

$("new-project").onclick = async () => {
  let name = "Nuevo proyecto";
  for (let number = 2; projects().some((project) => project.name === name); number += 1) name = `Nuevo proyecto ${number}`;
  if (!(await call("createProject", { name, folder: "Proyectos" }))) return;
  go("project", name);
  await load(true);
  $("title").focus();
  $("title").select();
};

$("title").onchange = async () => {
  const rename = $("title").value.trim();
  if (state.section !== "project" || !rename || rename === state.project) return;
  const done = await call("updateProject", { name: state.project, rename });
  if (done) state.project = done.name;
  await load(true);
};
$("title").onkeydown = (event) => {
  if (event.key === "Enter") $("title").blur();
};

$("project-menu").onclick = () => {
  const pop = $("project-pop");
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  const current = projects().find((project) => project.name === state.project);
  const name = state.project;
  const paused = current?.status === "onhold";
  pop.replaceChildren(
    el("button", {
      type: "button",
      textContent: paused ? "Reanudar" : "Pausar",
      onclick: async () => {
        pop.hidden = true;
        await call("updateProject", { name, status: paused ? "active" : "onhold" });
        await load(true);
      },
    }),
    el("button", {
      type: "button",
      textContent: "Archivar proyecto",
      onclick: async () => {
        pop.hidden = true;
        await call("updateProject", { name, status: "dropped" });
        toast("Proyecto archivado");
        go("today");
      },
    }),
  );
  pop.hidden = false;
};

let searchTimer = null;
$("search").oninput = (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = event.target.value.trim();
    closeDetail();
    load(true);
  }, 160);
};

document.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "n") {
    event.preventDefault();
    $("add-name").focus();
  }
  if (command && event.key.toLowerCase() === "f") {
    event.preventDefault();
    $("search").focus();
  }
  if (event.key === "Escape") {
    $("project-pop").hidden = true;
    if (state.selected) closeDetail();
  }
});

api.onFocusTask?.(async (id) => {
  const task = id ? await call("get", { id }) : null;
  if (task) {
    state.selected = null;
    select(task);
  }
});

(async () => {
  const status = await api.calendarStatus();
  if (status.ok) state.calendar = status.value;
  await load(true);
})();
setInterval(load, 20_000);
window.addEventListener("focus", () => load());
