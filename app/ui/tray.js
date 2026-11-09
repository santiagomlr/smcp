const $ = (id) => document.getElementById(id);
const panelNode = $("panel");
let lastKey = null;

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function row(on, name, meta, action) {
  const item = element(
    "li",
    {},
    element("span", { className: `panel-dot${on ? " on" : ""}` }),
    element("span", { className: "panel-name", textContent: name, title: name }),
    element("span", { className: "panel-meta", textContent: meta }),
  );
  if (action) item.append(action);
  return item;
}

function machineRow(machine) {
  const wake = machine.canWake
    ? element("button", { type: "button", textContent: "Encender", onclick: () => window.api.wake(machine.name) })
    : null;
  const meta = machine.self ? "Esta computadora" : machine.online ? "En línea" : wake ? "" : "Sin conexión";
  return row(machine.online, machine.alias || machine.name, meta, wake);
}

function connectionRows(state) {
  const rows = [];
  for (const client of state.clients.items) {
    if (client.connected) rows.push(row(true, client.name, "Conectado"));
  }
  if (state.whatsapp.supported && state.whatsapp.installed) {
    rows.push(row(state.whatsapp.linked, "WhatsApp", state.whatsapp.linked ? "Vinculado" : "Sin vincular"));
  }
  const vaults = state.notes.vaults.filter((vault) => vault.enabled);
  if (vaults.length) rows.push(row(true, "Notas", vaults.length === 1 ? vaults[0].name : `${vaults.length} bóvedas`));
  for (const account of state.gmail.accounts) {
    rows.push(row(true, account.label, "Gmail"));
  }
  if (state.remote.supported) {
    const count = state.remote.clients.length;
    rows.push(row(state.remote.enabled, "Acceso remoto", !state.remote.enabled ? "Apagado" : count ? `${count} ${count === 1 ? "app" : "apps"}` : "Sin apps"));
  }
  if (!rows.length) rows.push(row(false, "Sin conexiones", ""));
  return rows;
}

const TOP_TASKS = 6;
let tasksKey = null;
let undoTimer = null;

const resize = () => window.api.panelResize(document.documentElement.scrollHeight);

function dayLabel(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

function taskMeta(task) {
  const parts = [];
  if (task.p !== "INBOX") parts.push(task.p);
  if (task.min) parts.push(`${task.min} min`);
  if (task.due) parts.push(`vence ${dayLabel(task.due)}`);
  return parts.join(" · ");
}

function showUndo(task) {
  clearTimeout(undoTimer);
  $("p-undo-text").textContent = "Completada";
  $("p-undo").hidden = false;
  $("p-undo-button").onclick = async () => {
    $("p-undo").hidden = true;
    await window.api.tasks("reopen", { id: task.id });
    tasksKey = null;
    await loadTasks();
    resize();
  };
  undoTimer = setTimeout(() => {
    $("p-undo").hidden = true;
    resize();
  }, 6000);
}

function taskRow(task) {
  const check = element("button", { type: "button", className: "task-check" });
  check.setAttribute("aria-label", `Completar ${task.n}`);
  const item = element(
    "li",
    { className: "task" },
    element(
      "div",
      { className: "task-inner" },
      element(
        "div",
        { className: "task-row" },
        check,
        element(
          "button",
          { type: "button", className: "task-body", title: task.n, onclick: () => window.api.openTasks(task.id) },
          element("span", { className: "task-name", textContent: task.n }),
          element("span", { className: "task-meta", textContent: taskMeta(task) }),
        ),
      ),
    ),
  );
  check.onclick = async () => {
    check.disabled = true;
    item.classList.add("leaving");
    const result = await window.api.tasks("complete", { id: task.id });
    if (!result.ok) {
      item.classList.remove("leaving");
      check.disabled = false;
      return;
    }
    showUndo(task);
    await new Promise((done) => setTimeout(done, 300));
    tasksKey = null;
    await loadTasks();
    resize();
  };
  return item;
}

async function loadTasks() {
  const result = await window.api.tasks("list", { view: "available" });
  const empty = $("p-tasks-empty");
  if (!result.ok) {
    tasksKey = null;
    $("p-tasks").replaceChildren();
    $("p-all").textContent = "Ver todas";
    empty.textContent = "No se puede llegar a la computadora de tus tareas.";
    empty.hidden = false;
    return;
  }
  const top = result.value.slice(0, TOP_TASKS);
  const key = JSON.stringify([top, result.value.length]);
  if (key === tasksKey) return;
  tasksKey = key;
  $("p-tasks").replaceChildren(...top.map(taskRow));
  $("p-all").textContent = result.value.length > TOP_TASKS ? `Ver las ${result.value.length}` : "Abrir tareas";
  empty.textContent = "Nada disponible por ahora.";
  empty.hidden = top.length > 0;
}

async function refresh() {
  const result = await window.api.state();
  if (!result.ok) return;
  const state = result.value;
  const paused = state.policy.paused;
  const status = $("panel-status");
  status.textContent = paused ? "En pausa" : "Activo";
  status.classList.toggle("paused", paused);
  $("p-pause").checked = paused;
  await loadTasks();
  const key = JSON.stringify([state.tailscale.machines, state.clients, state.whatsapp.linked, state.gmail, state.notes, state.remote.enabled, state.remote.clients.length, state.remote.supported]);
  if (key === lastKey) return resize();
  lastKey = key;
  const machines = state.tailscale.machines;
  $("p-machines").replaceChildren(...(machines.length ? machines.map(machineRow) : [row(false, "Tailscale sin conectar", "")]));
  $("p-connections-list").replaceChildren(...connectionRows(state));
  window.api.panelResize(document.documentElement.scrollHeight);
}

$("panel-mark").append($("mark-template").content.firstElementChild.cloneNode(true));
$("p-pause").onchange = async (event) => {
  await window.api.setPolicy({ paused: event.target.checked });
  refresh();
};
$("p-open").onclick = () => window.api.openMain();
$("p-all").onclick = () => window.api.openTasks();
$("p-add").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("p-add-name");
  const name = input.value.trim();
  if (!name) return;
  const result = await window.api.tasks("create", { name });
  if (!result.ok) return;
  input.value = "";
  $("p-all").textContent = "Abrir tareas";
  $("p-undo").hidden = true;
  $("p-tasks-empty").hidden = true;
  $("p-add-saved").hidden = false;
  setTimeout(() => {
    $("p-add-saved").hidden = true;
    resize();
  }, 2200);
  tasksKey = null;
  await loadTasks();
  resize();
};
$("p-quit").onclick = () => window.api.quit();

window.api.onPanelShown(() => {
  panelNode.classList.remove("showing");
  void panelNode.offsetWidth; // Restart the entrance animation.
  panelNode.classList.add("showing");
  refresh();
});
window.api.onStateChanged(refresh);
document.fonts.ready.then(refresh);
