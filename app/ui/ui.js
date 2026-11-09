const $ = (id) => document.getElementById(id);
const GROUPS = ["whatsapp", "gmail", "notes", "tasks", "calendar", "reminders", "applenotes", "files", "clipboard", "terminal", "apps"];
const ACTIVITY_SHOWN = 30;
const openEditors = new Set();
let state = null;
let syncing = false;
let loggingIn = false;
let onboardingOpen = false;
let step = 0;
let renderedStep = null;
let onboardingKey = null;
let machinesKey = null;
let gmailKey = null;
let clientsKey = null;
let notesKey = null;
let activeTab = "connections";
let gmailFormOpen = false;

if (navigator.userAgent.includes("Macintosh")) document.body.classList.add("mac");

function showError(message) {
  $("error").textContent = message ? tr(message) : "";
  $("error").hidden = !message;
}

/** Runs an action, surfaces its error, then refreshes what's on screen. */
async function act(promise) {
  const result = await promise;
  showError(result.ok ? "" : result.error);
  await refresh();
  return result;
}

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function button(label, onClick, className = "") {
  return element("button", { type: "button", textContent: label, className, onclick: onClick });
}

function mark() {
  return $("mark-template").content.firstElementChild.cloneNode(true);
}

function osLabel(os) {
  return { macos: "Mac", windows: "Windows", ios: "iPhone", android: "Android", linux: "Linux" }[os] || os || tr("Device");
}

function machineDetail(machine) {
  if (machine.self) return tr("{os} · this computer", { os: osLabel(machine.os) });
  return tr(machine.online ? "{os} · online" : "{os} · offline", { os: osLabel(machine.os) });
}

function setStop(id, on) {
  $(id).classList.toggle("on", Boolean(on));
}

/* Machines */

function editor(machine) {
  const alias = element("input", { value: machine.alias, id: `alias-${machine.name}`, maxLength: 40, placeholder: machine.name });
  const user = element("input", { value: machine.user, id: `user-${machine.name}`, maxLength: 64, placeholder: tr("Default") });
  const save = button(tr("Save"), async () => {
    openEditors.delete(machine.name);
    machinesKey = null;
    await act(window.api.saveMachine(machine.name, { alias: alias.value.trim(), user: user.value.trim() }));
  });
  return element(
    "div",
    { className: "edit" },
    element(
      "div",
      { className: "edit-inner" },
      element("label", { htmlFor: alias.id, textContent: tr("Name") }),
      alias,
      element("label", { htmlFor: user.id, textContent: tr("SSH user") }),
      user,
      save,
    ),
  );
}

function machineStop(machine, index) {
  const row = element(
    "div",
    { className: "stop-row" },
    element(
      "div",
      { className: "stop-main" },
      element("div", { className: "stop-title", textContent: machine.alias || machine.name }),
      element("div", { className: "stop-meta", textContent: machineDetail(machine) }),
    ),
  );
  const actions = element("div", { className: "stop-actions" });
  actions.append(button(tr("Edit"), () => toggleEditor(machine.name, stop), "reveal quiet"));
  if (machine.canWake) actions.append(button(tr("Wake up"), () => act(window.api.wake(machine.name))));
  if (machine.online && !machine.self && machine.os !== "ios" && machine.os !== "android") {
    actions.append(button("Terminal", () => act(window.api.openTerminal(machine.name))));
  }
  row.append(actions);
  const fold = element("div", { className: `fold${openEditors.has(machine.name) ? " open" : ""}` }, editor(machine));
  const stop = element(
    "li",
    { className: `stop stop-group${machine.online ? " on" : ""}` },
    element("span", { className: "node" }),
    row,
    fold,
  );
  stop.style.setProperty("--i", String(index + 6));
  return stop;
}

function toggleEditor(name, stop) {
  const opening = !openEditors.has(name);
  if (opening) openEditors.add(name);
  else openEditors.delete(name);
  stop.querySelector(".fold").classList.toggle("open", opening);
}

function tailscaleStop({ tailscale }) {
  const actions = tailscale.installed
    ? button(tr("Open Tailscale"), () => act(window.api.openTailscale()), "primary")
    : button(tr("Download"), () => act(window.api.openLink("tailscale")), "primary");
  return element(
    "li",
    { className: "stop" },
    element("span", { className: "node" }),
    element(
      "div",
      { className: "stop-main" },
      element("div", { className: "stop-title", textContent: tr("Just this computer") }),
      element("div", {
        className: "stop-meta",
        textContent: tailscale.installed ? tr("Sign in to Tailscale to see your other devices.") : tr("Connect your other devices with Tailscale."),
      }),
    ),
    actions,
  );
}

function renderMachines() {
  if (document.activeElement?.closest?.(".edit")) return; // Do not wipe a form the person is typing in.
  const { machines } = state.tailscale;
  const key = JSON.stringify([machines, state.tailscale.installed]);
  if (key === machinesKey) return;
  machinesKey = key;
  $("machines").replaceChildren(...(machines.length ? machines.map(machineStop) : [tailscaleStop(state)]));
}

/* Connections */

function formatDate(iso) {
  if (!iso) return tr("not synced");
  const date = new Date(iso);
  const today = date.toDateString() === new Date().toDateString();
  const options = today ? { timeStyle: "short" } : { month: "short", day: "numeric" };
  return date.toLocaleString(SMCP_I18N.locale(), options);
}

const WHATSAPP_CHOICES = [
  { ability: "read", title: tr("Read your chats"), meta: tr("See and search your conversations.") },
  { ability: "send", title: tr("Write with your approval"), meta: tr("Claude drafts the message, and it's only sent if you press Send on this computer.") },
  { ability: "audio", title: tr("Listen to voice notes"), meta: tr("Your voice notes are turned into text on this computer, for free. Claude only gets the text.") },
];

function whatsappChoiceMeta({ ability, meta }) {
  if (ability !== "audio") return meta;
  const { ready, downloading, percent } = state.audio;
  if (downloading) return tr("Preparing on this computer: {percent}%.", { percent });
  if (!state.policy.whatsapp.read) return tr("To use this, turn on Read your chats.");
  return ready ? meta : tr("{meta} The first time, it downloads about 490 MB.", { meta });
}

function saveWhatsAppChoice(ability, allowed) {
  if (ability === "audio") return act(window.api.whatsappAudio(allowed));
  return act(window.api.setPolicy({ whatsapp: { [ability]: allowed } }));
}

/** Every copy of a choice (onboarding, Connections, Settings) shows the same saved state. */
function paintWhatsAppChoice(input) {
  const choice = WHATSAPP_CHOICES.find(({ ability }) => ability === input.dataset.waAbility);
  const { disabled, whatsapp: access } = state.policy;
  const audio = choice.ability === "audio";
  const row = input.closest("li");
  input.checked = access[choice.ability] || (audio && state.audio.downloading);
  input.disabled = disabled.whatsapp || (audio && !access.read);
  row.hidden = audio && !state.audio.supported;
  row.querySelector("[data-wa-meta]").textContent = whatsappChoiceMeta(choice);
  if (row.classList.contains("stop")) row.classList.toggle("on", input.checked && !input.disabled);
}

function paintWhatsAppChoices() {
  document.querySelectorAll("[data-wa-ability]").forEach(paintWhatsAppChoice);
}

function whatsappChoiceInput(id, ability) {
  const input = element("input", { id, type: "checkbox", className: "switch" });
  input.dataset.waAbility = ability;
  input.setAttribute("role", "switch");
  input.onchange = () => saveWhatsAppChoice(ability, input.checked);
  return input;
}

function whatsappChoiceMetaNode(tag, className = "") {
  const node = element(tag, { className });
  node.dataset.waMeta = "";
  return node;
}

function whatsappChoiceStop({ ability, title }, idPrefix) {
  const input = whatsappChoiceInput(`${idPrefix}-${ability}`, ability);
  const stop = element(
    "li",
    { className: "stop" },
    element("span", { className: "node" }),
    element(
      "label",
      { className: "stop-main", htmlFor: input.id },
      element("div", { className: "stop-title", textContent: title }),
      whatsappChoiceMetaNode("div", "stop-meta"),
    ),
    input,
  );
  paintWhatsAppChoice(input);
  return stop;
}

function whatsappChoices(idPrefix) {
  const nodes = [line(...WHATSAPP_CHOICES.map((choice) => whatsappChoiceStop(choice, idPrefix)))];
  if (state.policy.disabled.whatsapp) nodes.push(hint(tr("WhatsApp is off in Settings. Turn it on to choose.")));
  return nodes;
}

function closeWhatsAppQuestion() {
  $("wa-access-fold").classList.remove("open");
}

/** Right after linking from Connections; the onboarding asks this in its own step. */
function askWhatsAppAccess() {
  $("wa-access-home").replaceChildren(
    element("p", { className: "wa-access-title", textContent: tr("What can Claude do with WhatsApp?") }),
    ...whatsappChoices("wa-ask"),
    element("div", { className: "wa-access-end" }, hint(tr("You can change this anytime in Settings.")), button(tr("All set"), closeWhatsAppQuestion, "primary")),
  );
  $("wa-access-fold").classList.add("open");
}

$("wa-access-rows").replaceChildren(
  ...WHATSAPP_CHOICES.map(({ ability, title }) => {
    const input = whatsappChoiceInput(`wa-${ability}`, ability);
    return element("li", {}, element("label", { htmlFor: input.id }, title, whatsappChoiceMetaNode("small")), input);
  }),
);

function whatsappStatus({ messages, lastSync }) {
  const status = syncing ? tr("syncing…") : formatDate(lastSync);
  if (messages === 1) return tr("1 message · {status}", { status });
  return tr("{count} messages · {status}", { count: messages.toLocaleString(SMCP_I18N.locale()), status });
}

function renderWhatsApp() {
  const { whatsapp } = state;
  $("whatsapp-section").hidden = !whatsapp.supported;
  if (!whatsapp.supported) return;
  setStop("stop-whatsapp", whatsapp.linked);
  $("wa-title").textContent = "WhatsApp";
  $("wa-detail").textContent = !whatsapp.installed
    ? tr("Not available on this install")
    : whatsapp.linked
      ? whatsappStatus(whatsapp)
      : tr("Not linked");
  $("wa-sync").hidden = !whatsapp.linked;
  $("wa-sync").disabled = syncing;
  $("wa-disconnect").hidden = !whatsapp.linked;
  $("wa-link").hidden = !whatsapp.installed || whatsapp.linked;
  $("wa-link").disabled = loggingIn;
}

/* Gmail */

function field(label, input) {
  return element("label", { className: "field" }, label, input);
}

/** The same guided form appears in Connections and in the onboarding. */
function accountForm({ onDone, onCancel }) {
  const label = element("input", { type: "text", placeholder: tr("Work"), maxLength: 40, autocomplete: "off" });
  const email = element("input", { type: "email", placeholder: tr("name@gmail.com"), autocomplete: "off", spellcheck: false });
  const password = element("input", { type: "password", placeholder: tr("16 letters"), autocomplete: "off" });
  const error = element("p", { className: "form-error", hidden: true, role: "alert" });
  const submit = element("button", { type: "submit", textContent: tr("Connect"), className: "primary" });
  const actions = element("div", { className: "form-actions" });
  if (onCancel) actions.append(button(tr("Cancel"), onCancel, "quiet"));
  actions.append(submit);
  const steps = element(
    "ol",
    {},
    element("li", {}, tr("Turn on 2-Step Verification."), button(tr("Open"), () => act(window.api.openLink("twoStep")), "quiet")),
    element("li", {}, tr("Create an app password."), button(tr("Open"), () => act(window.api.openLink("appPasswords")), "quiet")),
    element("li", {}, tr("Paste it here.")),
  );
  const form = element(
    "form",
    {
      className: "account-form",
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        submit.textContent = tr("Connecting…");
        const result = await window.api.gmailAdd({ label: label.value, email: email.value, password: password.value });
        submit.disabled = false;
        submit.textContent = tr("Connect");
        if (!result.ok) {
          error.textContent = tr(result.error);
          error.hidden = false;
          return;
        }
        form.reset();
        onDone();
      },
    },
    steps,
    field(tr("Name"), label),
    field(tr("Email"), email),
    field(tr("App password"), password),
    error,
    actions,
  );
  return form;
}

function accountStop({ label, email }, index) {
  const stop = element(
    "li",
    { className: "stop on" },
    element("span", { className: "node" }),
    element(
      "div",
      { className: "stop-main" },
      element("div", { className: "stop-title", textContent: label }),
      element("div", { className: "stop-meta", textContent: label === email ? "Gmail" : email }),
    ),
    button(tr("Disconnect"), () => act(window.api.gmailRemove(email)), "reveal quiet"),
  );
  stop.style.setProperty("--i", String(index + 4));
  return stop;
}

function setGmailForm(open) {
  gmailFormOpen = open;
  $("gmail-fold").classList.toggle("open", open);
  $("gmail-toggle").hidden = open;
  if (open) {
    $("gmail-form-home").replaceChildren(
      accountForm({
        onDone: async () => {
          setGmailForm(false);
          await refresh();
        },
        onCancel: () => setGmailForm(false),
      }),
    );
    $("gmail-form-home").querySelector("input").focus({ preventScroll: true });
    setTimeout(() => $("gmail-fold").scrollIntoView({ block: "end", behavior: "smooth" }), 300);
  }
}

function renderGmail() {
  const { gmail } = state;
  $("gmail-section").hidden = !gmail.supported;
  const key = JSON.stringify(gmail.accounts);
  if (key !== gmailKey) {
    gmailKey = key;
    $("gmail-accounts").replaceChildren(...gmail.accounts.map(accountStop));
  }
  $("gmail-toggle").textContent = gmail.accounts.length ? tr("Add another account") : tr("Add Gmail account");
}

$("gmail-toggle").onclick = () => setGmailForm(true);

function clientStop(client) {
  const id = `client-${client.id}`;
  const input = element("input", { id, type: "checkbox", className: "switch", checked: client.connected });
  input.setAttribute("role", "switch");
  const stop = element(
    "li",
    { className: `stop${client.connected ? " on" : ""}` },
    element("span", { className: "node" }),
    element("label", { className: "stop-main", htmlFor: id, textContent: client.name }),
    input,
  );
  input.onchange = async () => {
    input.classList.add("busy");
    stop.classList.toggle("on", input.checked);
    clientsKey = null;
    onboardingKey = null;
    await act(window.api.setClient(client.id, input.checked));
  };
  return stop;
}

/* Notes */

function vaultStop(vault) {
  const id = `vault-${vault.path}`;
  const input = element("input", { id, type: "checkbox", className: "switch", checked: vault.enabled });
  input.setAttribute("role", "switch");
  const stop = element(
    "li",
    { className: `stop${vault.enabled ? " on" : ""}` },
    element("span", { className: "node" }),
    element(
      "label",
      { className: "stop-main", htmlFor: id },
      element("div", { className: "stop-title", textContent: vault.name }),
      element("div", { className: "stop-meta", textContent: vault.display }),
    ),
    input,
  );
  input.onchange = async () => {
    stop.classList.toggle("on", input.checked);
    notesKey = null;
    onboardingKey = null;
    await act(window.api.vaultSet(vault.path, input.checked));
  };
  return stop;
}

function renderNotes() {
  const { notes } = state;
  $("notes-section").hidden = !notes.supported;
  const key = JSON.stringify(notes.vaults);
  if (key === notesKey) return;
  notesKey = key;
  $("vaults-line").replaceChildren(...notes.vaults.map(vaultStop));
  $("vault-add").textContent = notes.vaults.length ? tr("Add another folder") : tr("Add notes folder");
}

$("vault-add").onclick = () => {
  notesKey = null;
  act(window.api.vaultAdd());
};

/* Tasks */

function renderTaskSettings() {
  const { tasks, tailscale } = state;
  const select = $("tasks-host");
  const options = [["", tr("This computer")], ...tailscale.machines.filter((machine) => !machine.self && machine.os === "macos" && machine.dns).map((machine) => [machine.dns, machine.alias || machine.name])];
  const key = JSON.stringify(options);
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...options.map(([value, label]) => element("option", { value, textContent: label })));
  }
  if (document.activeElement !== select) select.value = tasks.host ?? "";
  $("tasks-hub-row").hidden = Boolean(tasks.host) || !tailscale.running;
  $("tasks-hub").checked = tasks.hub;
}

$("tasks-host").onchange = async (event) => {
  await act(window.api.tasksSetHost(event.target.value || null));
};
$("tasks-hub").onchange = (event) => act(window.api.tasksSetHub(event.target.checked));

function renderClients() {
  const { clients } = state;
  $("clients-section").hidden = !clients.supported;
  const key = JSON.stringify(clients.items);
  if (key === clientsKey) return;
  clientsKey = key;
  $("clients-line").replaceChildren(...clients.items.map(clientStop));
}

/* Remote access */

function remoteClientRow(client) {
  const when = client.lastUsedAt ? tr("Used {date}", { date: new Date(client.lastUsedAt).toLocaleString(SMCP_I18N.locale(), { dateStyle: "short", timeStyle: "short" }) }) : tr("Connected");
  return element(
    "li",
    {},
    element("span", {}, client.name, element("small", { textContent: when })),
    button(tr("Disconnect"), () => act(window.api.remoteRevoke(client.id)), "quiet"),
  );
}

function renderRemote() {
  const { remote } = state;
  $("remote-section").hidden = !remote.supported;
  if (!remote.supported) return;
  setStop("stop-remote", remote.enabled);
  $("remote-switch").checked = remote.enabled;
  $("remote-fold").classList.toggle("open", remote.enabled);
  const count = remote.clients.length;
  $("remote-meta").textContent = !remote.enabled
    ? tr("To use SMCP from the Claude mobile app, Claude on the web and ChatGPT")
    : count === 1
      ? tr("1 app connected")
      : count
        ? tr("{count} apps connected", { count })
        : tr("On, no apps connected");
  $("remote-url").textContent = remote.url ?? "";
  $("remote-code").textContent = remote.pairing?.code ?? tr("No active code");
  $("remote-clients").replaceChildren(...remote.clients.map(remoteClientRow));
}

$("remote-switch").onchange = async (event) => {
  event.target.classList.add("busy");
  await act(window.api.remoteSet(event.target.checked));
  event.target.classList.remove("busy");
};
$("remote-new-code").onclick = () => act(window.api.remoteCode());
$("remote-copy").onclick = async () => {
  const result = await window.api.remoteCopy();
  if (!result.ok) return showError(result.error);
  $("remote-copy").textContent = tr("Copied");
  setTimeout(() => ($("remote-copy").textContent = tr("Copy")), 1500);
};

function renderSettings() {
  const { policy, permissions } = state;
  $("policy-paused").checked = policy.paused;
  $("policy-readonly").checked = policy.readOnly;
  for (const group of GROUPS) $(`group-${group}`).checked = !policy.disabled[group];
  $("whatsapp-access").hidden = !state.whatsapp.supported;
  $("wa-access-off").hidden = !policy.disabled.whatsapp;
  $("open-at-login").checked = state.openAtLogin;
  $("mac-perms").hidden = state.platform !== "darwin";
  setStop("stop-perm-accessibility", permissions.accessibility);
  setStop("stop-perm-screen", permissions.screen);
  for (const node of document.querySelectorAll("[data-privacy]")) node.hidden = permissions[node.dataset.privacy];
  $("paused-banner").hidden = !policy.paused;
  $("version").textContent = tr("Version {version}", { version: state.version });
  if (activeTab === "settings") renderActivity();
}

const OUTCOME_LABELS = { ok: "Done", error: "Failed", denied: "Blocked", failed: "Failed" };

/** The last calls, newest first. Only names, times and outcomes: the log holds nothing else. */
async function renderActivity() {
  const result = await window.api.auditList();
  const list = $("activity");
  if (!result.ok) {
    list.replaceChildren();
    $("activity-status").textContent = tr(result.error);
    return;
  }
  const entries = result.value;
  const time = new Intl.DateTimeFormat(SMCP_I18N.locale(), { dateStyle: "short", timeStyle: "short" });
  list.replaceChildren(
    ...entries.slice(0, ACTIVITY_SHOWN).map((entry) =>
      element(
        "li",
        { className: `activity-${entry.outcome}` },
        element("span", { className: "activity-tool", textContent: entry.tool }),
        element("small", {
          textContent: [
            time.format(new Date(entry.at)),
            tr(entry.source === "remote" ? "Remote" : "This computer"),
            entry.client,
            tr(OUTCOME_LABELS[entry.outcome] ?? "Failed"),
          ]
            .filter(Boolean)
            .join(" · "),
        }),
      ),
    ),
  );
  $("activity-status").textContent = entries.length ? tr("{count} recent calls", { count: entries.length }) : tr("No calls yet.");
  $("activity-clear").disabled = !entries.length;
}

function renderSummary() {
  const { tailscale, whatsapp, clients, policy, gmail } = state;
  if (policy.paused) {
    $("summary").textContent = tr("Paused");
    return;
  }
  const online = tailscale.machines.filter((machine) => machine.online && !machine.self).length;
  const apps = clients.items.filter((client) => client.connected).length + state.remote.clients.length;
  const vaults = state.notes.vaults.filter((vault) => vault.enabled).length;
  const active = apps + Number(Boolean(whatsapp.linked)) + gmail.accounts.length + vaults + online;
  $("summary").textContent = active === 1 ? tr("1 active connection") : active ? tr("{count} active connections", { count: active }) : tr("No connections yet");
}

/* Onboarding */

function heading(title, text) {
  return [element("h2", { className: "ob-title", textContent: title }), element("p", { className: "ob-text", textContent: text })];
}

function switchStop(label, id, checked, onChange) {
  const input = element("input", { id, type: "checkbox", className: "switch", checked, onchange: onChange });
  input.setAttribute("role", "switch");
  return element(
    "li",
    { className: `stop${checked ? " on" : ""}` },
    element("span", { className: "node" }),
    element("label", { className: "stop-main", htmlFor: id, textContent: label }),
    input,
  );
}

function statusStop(on, title, meta, ...actions) {
  return element(
    "li",
    { className: `stop${on ? " on" : ""}` },
    element("span", { className: "node" }),
    element(
      "div",
      { className: "stop-main" },
      element("div", { className: "stop-title", textContent: title }),
      element("div", { className: "stop-meta", textContent: meta }),
    ),
    ...actions,
  );
}

function line(...stops) {
  return element("ol", { className: "line" }, ...stops);
}

function hint(text) {
  return element("p", { className: "hint", textContent: text });
}

function logo() {
  return element("div", { className: "ob-mark" }, mark());
}

function setClientFrom(client) {
  return (event) => {
    event.target.classList.add("busy");
    onboardingKey = null;
    return act(window.api.setClient(client, event.target.checked));
  };
}

const STEPS = {
  welcome: () => [
    logo(),
    ...heading(tr("Connect your AI to your computer"), tr("So it can help with your chats, files and apps. It takes a few minutes, and you can skip any step.")),
  ],
  claude: () => [
    ...heading(tr("Which AI apps do you use?"), tr("Choose the ones that get access. Then restart them.")),
    line(...state.clients.items.map((client) => switchStop(client.name, `ob-${client.id}`, client.connected, setClientFrom(client.id)))),
  ],
  whatsapp: () => {
    const warning = hint(tr("WhatsApp doesn't officially offer this access, so it could restrict your account. Avoid mass messaging."));
    if (state.whatsapp.linked) {
      return [
        ...heading(tr("What can Claude do with WhatsApp?"), tr("WhatsApp is already linked. Choose what you allow; you can change it anytime in Settings.")),
        ...whatsappChoices("ob-wa"),
        warning,
      ];
    }
    return [
      ...heading(tr("Link WhatsApp"), tr("Scan a code with your phone. Then choose what Claude can do with your chats.")),
      line(statusStop(false, "WhatsApp", tr("Not linked"), button(tr("Show QR code"), () => window.api.whatsappLogin(), "primary"))),
      warning,
      $("wa-qr"),
    ];
  },
  gmail: () => {
    const { accounts } = state.gmail;
    const stops = accounts.map(({ label, email }) => statusStop(true, label, label === email ? "Gmail" : email));
    return [
      ...heading(tr("Connect your email"), tr("You can add every Gmail account you use. Nothing is sent without your approval.")),
      ...(stops.length ? [line(...stops)] : []),
      accountForm({
        onDone: () => {
          onboardingKey = null;
          refresh();
        },
      }),
      hint(tr("The password is stored encrypted on your computer. If it's a work account, this option may be blocked.")),
    ];
  },
  notes: () => {
    const { vaults } = state.notes;
    return [
      ...heading(tr("Connect your notes"), tr("Choose the Obsidian vaults or Markdown folders your AI can read. It only sees the ones you turn on.")),
      ...(vaults.length ? [line(...vaults.map(vaultStop))] : []),
      button(vaults.length ? tr("Add another folder") : tr("Choose folder"), () => {
        onboardingKey = null;
        act(window.api.vaultAdd());
      }),
      hint(tr("From your phone they can only be read. Writing notes only works on this computer.")),
    ];
  },
  tailscale: () => {
    const { tailscale } = state;
    const actions = tailscale.running
      ? []
      : tailscale.installed
        ? [button(tr("Open Tailscale"), () => act(window.api.openTailscale()), "primary")]
        : [button(tr("Download"), () => act(window.api.openLink("tailscale")), "primary")];
    const count = tailscale.machines.length;
    const networkMeta = count === 1 ? tr("1 device on your network") : tr("{count} devices on your network", { count });
    const meta = tailscale.running ? networkMeta : tailscale.installed ? tr("Not signed in yet") : tr("Not installed");
    return [
      ...heading(tr("Have more computers?"), tr("Tailscale joins them in a private network so you can reach them from anywhere. If you only use this one, skip this step.")),
      line(statusStop(tailscale.running, "Tailscale", meta, ...actions)),
      hint(tr("It's a separate app, free for personal use. Install it, sign in and come back: this screen updates by itself.")),
    ];
  },
  permissions: () => {
    const { accessibility, screen } = state.permissions;
    const activate = (on, pane) => (on ? [] : [button(tr("Turn on"), () => act(window.api.openPrivacy(pane)))]);
    return [
      ...heading(tr("Your Mac's permissions"), tr("Only if you want Claude to control apps or take screenshots. Press Turn on, then switch on SMCP in the list.")),
      line(
        statusStop(accessibility, tr("Accessibility"), tr("To control apps"), ...activate(accessibility, "accessibility")),
        statusStop(screen, tr("Screen Recording"), tr("To take screenshots"), ...activate(screen, "screen")),
      ),
      hint(tr("After you turn on Screen Recording, macOS asks you to restart SMCP.")),
    ];
  },
  done: () => [
    logo(),
    ...heading(tr("All connected"), tr("SMCP stays in the menu bar. Restart your AI app and try: “Summarize my unread WhatsApp chats.”")),
  ],
};

function stepNames() {
  if (!state) return ["welcome"];
  if (state.platform !== "darwin") return ["welcome", "tailscale", "done"];
  return ["welcome", "claude", "whatsapp", "gmail", "notes", "tailscale", "permissions", "done"];
}

function renderRail(names) {
  const rail = $("ob-rail");
  if (rail.children.length !== names.length) rail.replaceChildren(...names.map(() => element("li")));
  [...rail.children].forEach((node, index) => {
    node.classList.toggle("done", index < step);
    node.classList.toggle("reached", index <= step);
  });
}

function renderOnboarding() {
  if (document.activeElement?.closest?.("#ob-body form")) return; // Do not wipe a form the person is typing in.
  const names = stepNames();
  step = Math.min(step, names.length - 1);
  const name = names[step];
  const key = JSON.stringify([name, state.clients, state.gmail.accounts, state.notes.vaults, state.whatsapp.linked, state.tailscale.running, state.tailscale.installed, state.tailscale.machines.length, state.permissions]);
  renderRail(names);
  if (key === onboardingKey) return;
  onboardingKey = key;
  if (name !== "whatsapp" || state.whatsapp.linked) $("qr-home").append($("wa-qr"));
  const direction = renderedStep === null || step > renderedStep ? "forward" : step < renderedStep ? "back" : "";
  renderedStep = step;
  const content = element("div", { className: `ob-step ${direction}` }, ...STEPS[name]());
  [...content.children].forEach((child, index) => child.style.setProperty("--i", String(index)));
  $("ob-body").replaceChildren(content);
  const middle = names.length - 2;
  $("ob-progress").textContent = name === "welcome" || name === "done" ? "" : tr("Step {step} of {total}", { step, total: middle });
  $("ob-back").hidden = step === 0;
  $("ob-skip").hidden = name === "welcome" || name === "done";
  $("ob-next").textContent = name === "welcome" ? tr("Get started") : name === "done" ? tr("Open SMCP") : tr("Continue");
}

async function finishOnboarding() {
  await window.api.setOnboarded(true);
  onboardingOpen = false;
  step = 0;
  renderedStep = null;
  onboardingKey = null;
  playEntrance();
  await refresh();
}

function advance() {
  if (step >= stepNames().length - 1) return finishOnboarding();
  step += 1;
  renderOnboarding();
}

$("ob-next").onclick = advance;
$("ob-skip").onclick = advance;
$("ob-back").onclick = () => {
  step = Math.max(0, step - 1);
  renderOnboarding();
};

/* Screens */

function playEntrance() {
  const shell = $("app");
  shell.classList.add("enter");
  $("brand-mark").replaceChildren(mark());
  document.querySelectorAll("#view-connections h2, #view-connections .stop, #view-connections .hint").forEach((node, index) => {
    node.style.setProperty("--i", String(index));
  });
  setTimeout(() => shell.classList.remove("enter"), 1500);
}

async function refresh() {
  const result = await window.api.state();
  if (!result.ok) {
    showError(result.error);
    return;
  }
  state = result.value;
  paintWhatsAppChoices();
  if (!state.onboarded) onboardingOpen = true;
  const appWasHidden = $("app").hidden;
  $("onboarding").hidden = !onboardingOpen;
  $("app").hidden = onboardingOpen;
  if (onboardingOpen) {
    renderOnboarding();
    return;
  }
  renderSummary();
  renderMachines();
  renderWhatsApp();
  renderGmail();
  renderNotes();
  renderClients();
  renderRemote();
  renderSettings();
  renderTaskSettings();
  moveIndicator();
  if (appWasHidden) playEntrance();
}

function moveIndicator() {
  const active = document.querySelector('.tabs [aria-selected="true"]');
  if (!active || !active.offsetWidth) return;
  $("tab-indicator").style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth})`;
}

function selectTab(name) {
  activeTab = name;
  for (const tab of ["connections", "settings"]) {
    $(`view-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
  }
  const view = $(`view-${name}`);
  view.classList.remove("entering");
  void view.offsetWidth; // Restart the entrance animation.
  view.classList.add("entering");
  moveIndicator();
  if (name === "settings") renderActivity();
}

window.api.onSelectTab(selectTab);
$("tab-tasks").onclick = () => window.api.openTasks();
$("tab-connections").onclick = () => selectTab("connections");
$("tab-settings").onclick = () => selectTab("settings");

$("wa-sync").onclick = async () => {
  syncing = true;
  renderWhatsApp();
  const result = await window.api.whatsappSync();
  syncing = false;
  showError(result.ok ? "" : result.error);
  await refresh();
};

$("wa-link").onclick = () => window.api.whatsappLogin();
$("wa-disconnect").onclick = async () => {
  await act(window.api.whatsappDisconnect());
  if (!state.whatsapp.linked) closeWhatsAppQuestion();
};
$("wa-cancel").onclick = () => window.api.whatsappLoginCancel();

window.api.onAudioProgress(({ error, ...audio }) => {
  if (!state) return;
  state.audio = { ...state.audio, ...audio };
  paintWhatsAppChoices();
  if (error) showError(error);
  if (!audio.downloading) refresh(); // The switch turns on only when the download finished.
});

window.api.onLoginEvent(({ state: login, image, error }) => {
  loggingIn = login === "starting" || login === "qr";
  $("wa-qr").hidden = !loggingIn;
  $("wa-qr-image").hidden = login !== "qr";
  if (image) $("wa-qr-image").src = image;
  $("wa-qr-text").textContent =
    login === "qr" ? tr("On your phone: WhatsApp > Linked Devices > Link a Device.") : tr("Preparing the code…");
  if (!onboardingOpen) $("wa-link").disabled = loggingIn;
  if (login === "error") showError(error);
  if (login === "done") {
    showError("");
    onboardingKey = null;
    if (!onboardingOpen) askWhatsAppAccess();
  }
});

$("policy-paused").onchange = (event) => act(window.api.setPolicy({ paused: event.target.checked }));
$("policy-readonly").onchange = (event) => act(window.api.setPolicy({ readOnly: event.target.checked }));
$("resume").onclick = () => act(window.api.setPolicy({ paused: false }));
for (const group of GROUPS) {
  $(`group-${group}`).onchange = (event) => act(window.api.setPolicy({ disabled: { [group]: !event.target.checked } }));
}
for (const node of document.querySelectorAll("[data-privacy]")) {
  node.onclick = () => act(window.api.openPrivacy(node.dataset.privacy));
}

$("open-at-login").onchange = (event) => act(window.api.setOpenAtLogin(event.target.checked));
$("redo-onboarding").onclick = () => {
  onboardingOpen = true;
  step = 0;
  renderedStep = null;
  onboardingKey = null;
  refresh();
};
$("activity-clear").onclick = async () => {
  const result = await window.api.auditClear();
  showError(result.ok ? "" : result.error);
  renderActivity();
};
$("copy-diagnostics").onclick = async () => {
  const result = await window.api.copyDiagnostics();
  if (result.ok) $("diag-status").textContent = tr("Copied to clipboard.");
  else showError(result.error);
};
$("language").value = SMCP_I18N.language();
$("language").onchange = (event) => window.api.setLanguage(event.target.value);
$("wa-qr-image").alt = tr("QR code to link WhatsApp");

$("restart").onclick = () => window.api.restart();
$("quit").onclick = () => window.api.quit();

let updates = null;

function updateStatusText({ status, latest, message, current }) {
  if (status === "checking") return tr("Checking…");
  if (status === "installing" || status === "error") return tr(message);
  if (status === "latest") return tr("You're on the latest version.");
  if (status === "available") return tr("Version {version} is available.", { version: latest });
  return tr("You're on version {version}.", { version: current });
}

function renderUpdateProgress({ status, progress }) {
  const bar = $("update-progress");
  bar.hidden = status !== "checking" && status !== "installing";
  if (bar.hidden) return;
  const known = typeof progress === "number";
  bar.classList.toggle("indeterminate", !known);
  $("update-fill").style.width = known ? `${progress}%` : "";
  $("update-percent").textContent = known ? `${progress}%` : "";
  if (known) bar.setAttribute("aria-valuenow", String(progress));
  else bar.removeAttribute("aria-valuenow");
}

function renderUpdates(value) {
  updates = value;
  renderUpdateProgress(value);
  const button = $("check-updates");
  const installable = value.status === "available" && value.canInstall;
  const manual = value.status === "available" && !value.canInstall;
  $("update-status").textContent = updateStatusText(value);
  button.textContent = installable ? tr("Update to {version}", { version: value.latest }) : manual ? tr("Download") : tr("Check for updates");
  button.disabled = value.status === "checking" || value.status === "installing";
  $("auto-update").checked = value.auto === true;
  $("auto-update-note").textContent =
    window.api && navigator.userAgent.includes("Mac") ? tr("On Mac, each new version asks for system permissions again.") : "";
}

async function loadUpdates() {
  const result = await window.api.updatesState();
  if (result.ok) renderUpdates(result.value);
}

$("check-updates").onclick = async () => {
  if (updates?.status === "available" && !updates.canInstall) return act(window.api.openLink("releases"));
  const available = updates?.status === "available";
  const result = await (available ? window.api.updatesInstall() : window.api.updatesCheck());
  if (result.ok) renderUpdates(result.value);
  else showError(result.error);
};
$("auto-update").onchange = async (event) => {
  await act(window.api.updatesSetAuto(event.target.checked));
  await loadUpdates();
};
window.api.onUpdatesChanged(loadUpdates);
loadUpdates();

document.fonts.ready.then(moveIndicator);
refresh();
setInterval(refresh, 15_000);
window.addEventListener("focus", refresh);
window.addEventListener("resize", moveIndicator);
