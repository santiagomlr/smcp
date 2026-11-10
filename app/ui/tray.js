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

/** A row button that shows its progress and outcome, since the panel has no other place for errors. */
function actionButton(label, busyLabel, run, meta) {
  const button = element("button", { type: "button", textContent: label });
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = busyLabel;
    const result = await run();
    if (result.ok) {
      button.textContent = result.done;
      meta.textContent = "";
    } else {
      button.textContent = label;
      button.disabled = false;
      meta.textContent = tr("Failed");
      meta.title = result.error;
    }
    resize();
  };
  return button;
}

async function wake(name) {
  const result = await window.api.wake(name);
  return result.ok ? { ok: true, done: tr("Sent") } : result;
}

async function update(name) {
  const result = await window.api.updateMachine(name);
  if (!result.ok) return result;
  return { ok: true, done: result.value?.status === "latest" ? tr("Up to date") : tr("Updating…") };
}

function machineRow(machine) {
  const meta = machine.self
    ? tr("This computer")
    : machine.outdated && !machine.canUpdate
      ? tr("Update available")
      : machine.online
        ? tr("Online")
        : machine.canWake
          ? ""
          : tr("Offline");
  const item = row(machine.online, machine.alias || machine.name, meta);
  const metaNode = item.querySelector(".panel-meta");
  if (machine.smcp) metaNode.title = `SMCP ${machine.smcp.version}`;
  if (machine.canWake) item.append(actionButton(tr("Wake"), tr("Waking…"), () => wake(machine.name), metaNode));
  if (machine.canUpdate) {
    metaNode.textContent = "";
    item.append(actionButton(tr("Update"), tr("Updating…"), () => update(machine.name), metaNode));
  }
  return item;
}

/** A line under the header while this computer has a newer SMCP waiting. */
function renderUpdate(update) {
  const box = $("p-update");
  const available = update?.status === "available";
  const installing = update?.status === "installing";
  box.hidden = !available && !installing;
  if (box.hidden) return;
  $("p-update-text").textContent = installing ? tr("Updating SMCP…") : tr("SMCP {version} is available", { version: update.latest });
  const button = $("p-update-button");
  button.hidden = installing;
  button.disabled = false;
  button.textContent = update.canInstall ? tr("Update") : tr("Download");
  button.onclick = async () => {
    if (!update.canInstall) return window.api.openLink("releases");
    button.disabled = true;
    button.textContent = tr("Updating…");
    await window.api.updatesInstall();
  };
}

function connectionRows(state) {
  const rows = [];
  for (const client of state.clients.items) {
    if (client.connected) rows.push(row(true, client.name, tr("Connected")));
  }
  if (state.whatsapp.supported && state.whatsapp.installed) {
    rows.push(row(state.whatsapp.linked, "WhatsApp", state.whatsapp.linked ? tr("Linked") : tr("Not linked")));
  }
  const vaults = state.notes.vaults.filter((vault) => vault.enabled);
  if (vaults.length) rows.push(row(true, tr("Notes"), vaults.length === 1 ? vaults[0].name : tr("{count} vaults", { count: vaults.length })));
  for (const account of state.gmail.accounts) {
    rows.push(row(true, account.label, "Gmail"));
  }
  if (state.remote.supported) {
    const count = state.remote.clients.length;
    rows.push(row(state.remote.enabled, tr("Remote access"), !state.remote.enabled ? tr("Off") : count === 1 ? tr("1 app") : count ? tr("{count} apps", { count }) : tr("No apps")));
  }
  if (!rows.length) rows.push(row(false, tr("No connections"), ""));
  return rows;
}

const TOP_TASKS = 6;
let tasksKey = null;
let undoTimer = null;

const resize = () => window.api.panelResize(document.documentElement.scrollHeight);

function dayLabel(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(SMCP_I18N.locale(), { day: "numeric", month: "short" });
}

function taskMeta(task) {
  const parts = [];
  if (task.p !== "INBOX") parts.push(task.p);
  if (task.min) parts.push(tr("{minutes} min", { minutes: task.min }));
  if (task.due) parts.push(tr("due {date}", { date: dayLabel(task.due) }));
  return parts.join(" · ");
}

function showUndo(task) {
  clearTimeout(undoTimer);
  $("p-undo-text").textContent = tr("Completed");
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
  check.setAttribute("aria-label", tr("Complete {name}", { name: task.n }));
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
    $("p-all").textContent = tr("See all");
    empty.textContent = tr("Can't reach the computer that holds your tasks.");
    empty.hidden = false;
    return;
  }
  const top = result.value.slice(0, TOP_TASKS);
  const key = JSON.stringify([top, result.value.length]);
  if (key === tasksKey) return;
  tasksKey = key;
  $("p-tasks").replaceChildren(...top.map(taskRow));
  $("p-all").textContent = result.value.length > TOP_TASKS ? tr("See all {count}", { count: result.value.length }) : tr("Open Tasks");
  empty.textContent = tr("Nothing available right now.");
  empty.hidden = top.length > 0;
}

async function refresh() {
  const result = await window.api.state();
  if (!result.ok) return;
  const state = result.value;
  const paused = state.policy.paused;
  const status = $("panel-status");
  status.textContent = paused ? tr("Paused") : tr("Active");
  status.classList.toggle("paused", paused);
  $("p-pause").checked = paused;
  await loadTasks();
  const light = await window.api.nightlight("status");
  if (light.ok) renderNightLight(light.value);
  const keepAwake = await window.api.awake("status");
  if (keepAwake.ok) renderAwake(keepAwake.value);
  renderUpdate(state.update);
  const key = JSON.stringify([state.tailscale.machines, state.update, state.clients, state.whatsapp.linked, state.gmail, state.notes, state.remote.enabled, state.remote.clients.length, state.remote.supported]);
  if (key === lastKey) return resize();
  lastKey = key;
  const machines = state.tailscale.machines;
  $("p-machines").replaceChildren(...(machines.length ? machines.map(machineRow) : [row(false, tr("Tailscale not connected"), "")]));
  $("p-connections-list").replaceChildren(...connectionRows(state));
  window.api.panelResize(document.documentElement.scrollHeight);
}

// Night light: a quick switch and a slider for right now, like f.lux in the menu bar.
const NL = globalThis.SMCP_NIGHTLIGHT;
let nlDragging = false;

function renderNightLight(status) {
  $("p-nightlight").hidden = status.supported === false;
  if (status.supported === false) return;
  $("p-nl-enabled").checked = status.enabled;
  const kelvin = status.now?.kelvin ?? status.settings.bedtime;
  if (!nlDragging) {
    $("p-nl-kelvin").value = kelvin;
    $("p-nl-value").textContent = `${kelvin}K`;
  }
  $("p-nl-note").textContent = NL.nowText(status);
  $("p-nl-resume").hidden = status.now?.source !== "manual";
}

async function nightLight(op, args) {
  const result = await window.api.nightlight(op, args);
  if (result.ok) renderNightLight(result.value);
  resize();
}

$("p-nl-enabled").onchange = (event) => nightLight("configure", { enabled: event.target.checked });
$("p-nl-kelvin").oninput = (event) => {
  nlDragging = true;
  $("p-nl-value").textContent = `${event.target.value}K`;
  window.api.nightlight("preview", { kelvin: Number(event.target.value), brightness: 1 });
};
// Letting go keeps that color until the next wake time.
$("p-nl-kelvin").onchange = async (event) => {
  nlDragging = false;
  await nightLight("setNow", { kelvin: Number(event.target.value) });
};
$("p-nl-resume").onclick = () => nightLight("clearNow");
window.api.onNightLightChanged(() => nightLight("status"));

// Keep awake: a switch, how long, closed lid and screen off, like Amphetamine in the menu bar.
const AW = globalThis.SMCP_AWAKE;
let awakeState = null;

function renderAwake(status) {
  awakeState = status;
  $("p-awake").hidden = status.supported === false;
  $("p-aw-enabled").checked = status.active;
  const length = AW.lengthOf(status);
  if (length !== null) $("p-aw-length").value = length;
  const mac = status.platform === "darwin";
  $("p-aw-screen").hidden = !mac;
  $("p-aw-lid-row").hidden = !mac;
  $("p-aw-lid").checked = status.settings.closedLid;
  $("p-aw-note").textContent = AW.nowText(status);
  const warning = status.warnings?.[0];
  $("p-aw-warning").textContent = warning ? AW.warningText(warning) : "";
  $("p-aw-warning").hidden = !warning;
}

async function awake(op, args) {
  const result = await window.api.awake(op, args);
  if (result.ok && result.value && "active" in result.value) renderAwake(result.value);
  else if (!result.ok) {
    $("p-aw-warning").textContent = result.error;
    $("p-aw-warning").hidden = false;
  }
  resize();
}

$("p-aw-enabled").onchange = (event) => (event.target.checked ? awake("start", AW.startArgs($("p-aw-length").value)) : awake("stop"));
// Choosing another length while it is on starts again with that length.
$("p-aw-length").onchange = (event) => {
  if (awakeState?.active) awake("start", AW.startArgs(event.target.value));
};
$("p-aw-lid").onchange = async (event) => {
  await awake("configure", { closedLid: event.target.checked });
  // The one-time setup lives in Settings, where there is room to explain it.
  if (event.target.checked && awakeState && !awakeState.closedLidReady) window.api.openMain("settings");
};
$("p-aw-screen").onclick = () => awake("screenOff");
window.api.onAwakeChanged(() => awake("status"));

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
  $("p-all").textContent = tr("Open Tasks");
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
