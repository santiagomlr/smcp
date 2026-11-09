const $ = (id) => document.getElementById(id);
const GROUPS = ["whatsapp", "gmail", "notes", "tasks", "files", "terminal", "apps"];
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
  $("error").textContent = message || "";
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
  return { macos: "Mac", windows: "Windows", ios: "iPhone", android: "Android", linux: "Linux" }[os] || os || "Equipo";
}

function machineDetail(machine) {
  if (machine.self) return `${osLabel(machine.os)} · esta computadora`;
  return `${osLabel(machine.os)} · ${machine.online ? "en línea" : "sin conexión"}`;
}

function setStop(id, on) {
  $(id).classList.toggle("on", Boolean(on));
}

/* Machines */

function editor(machine) {
  const alias = element("input", { value: machine.alias, id: `alias-${machine.name}`, maxLength: 40, placeholder: machine.name });
  const user = element("input", { value: machine.user, id: `user-${machine.name}`, maxLength: 64, placeholder: "Predeterminado" });
  const save = button("Guardar", async () => {
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
      element("label", { htmlFor: alias.id, textContent: "Nombre" }),
      alias,
      element("label", { htmlFor: user.id, textContent: "Usuario SSH" }),
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
  actions.append(button("Editar", () => toggleEditor(machine.name, stop), "reveal quiet"));
  if (machine.canWake) actions.append(button("Encender", () => act(window.api.wake(machine.name))));
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
    ? button("Abrir Tailscale", () => act(window.api.openTailscale()), "primary")
    : button("Descargar", () => act(window.api.openLink("tailscale")), "primary");
  return element(
    "li",
    { className: "stop" },
    element("span", { className: "node" }),
    element(
      "div",
      { className: "stop-main" },
      element("div", { className: "stop-title", textContent: "Solo esta computadora" }),
      element("div", {
        className: "stop-meta",
        textContent: tailscale.installed ? "Inicia sesión en Tailscale para ver tus otras máquinas." : "Conecta tus otras máquinas con Tailscale.",
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
  if (!iso) return "sin sincronizar";
  const date = new Date(iso);
  const today = date.toDateString() === new Date().toDateString();
  const options = today ? { timeStyle: "short" } : { month: "short", day: "numeric" };
  return date.toLocaleString("es-MX", options);
}

const WHATSAPP_CHOICES = [
  { ability: "read", title: "Leer tus chats", meta: "Ver y buscar tus conversaciones." },
  { ability: "send", title: "Escribir con tu aprobación", meta: "Claude prepara el mensaje y solo sale si presionas Enviar en esta computadora." },
  { ability: "audio", title: "Escuchar audios", meta: "Tus notas de voz se convierten en texto en esta computadora, gratis. A Claude solo le llega el texto." },
];

function whatsappChoiceMeta({ ability, meta }) {
  if (ability !== "audio") return meta;
  const { ready, downloading, percent } = state.audio;
  if (downloading) return `Preparando en esta computadora: ${percent}%.`;
  if (!state.policy.whatsapp.read) return "Para usarlo, enciende Leer tus chats.";
  return ready ? meta : `${meta} La primera vez descarga unos 490 MB.`;
}

function saveWhatsAppChoice(ability, allowed) {
  if (ability === "audio") return act(window.api.whatsappAudio(allowed));
  return act(window.api.setPolicy({ whatsapp: { [ability]: allowed } }));
}

/** Every copy of a choice (onboarding, Conexiones, Ajustes) shows the same saved state. */
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
  if (state.policy.disabled.whatsapp) nodes.push(hint("WhatsApp está apagado en Ajustes. Enciéndelo para elegir."));
  return nodes;
}

function closeWhatsAppQuestion() {
  $("wa-access-fold").classList.remove("open");
}

/** Right after linking from Conexiones; the onboarding asks this in its own step. */
function askWhatsAppAccess() {
  $("wa-access-home").replaceChildren(
    element("p", { className: "wa-access-title", textContent: "¿Qué puede hacer Claude con WhatsApp?" }),
    ...whatsappChoices("wa-ask"),
    element("div", { className: "wa-access-end" }, hint("Puedes cambiarlo cuando quieras en Ajustes."), button("Listo", closeWhatsAppQuestion, "primary")),
  );
  $("wa-access-fold").classList.add("open");
}

$("wa-access-rows").replaceChildren(
  ...WHATSAPP_CHOICES.map(({ ability, title }) => {
    const input = whatsappChoiceInput(`wa-${ability}`, ability);
    return element("li", {}, element("label", { htmlFor: input.id }, title, whatsappChoiceMetaNode("small")), input);
  }),
);

function renderWhatsApp() {
  const { whatsapp } = state;
  $("whatsapp-section").hidden = !whatsapp.supported;
  if (!whatsapp.supported) return;
  setStop("stop-whatsapp", whatsapp.linked);
  $("wa-title").textContent = "WhatsApp";
  $("wa-detail").textContent = !whatsapp.installed
    ? "No disponible en esta instalación"
    : whatsapp.linked
      ? `${whatsapp.messages.toLocaleString("es-MX")} mensajes · ${syncing ? "sincronizando…" : formatDate(whatsapp.lastSync)}`
      : "Sin vincular";
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

/** The same guided form appears in Conexiones and in the onboarding. */
function accountForm({ onDone, onCancel }) {
  const label = element("input", { type: "text", placeholder: "Trabajo", maxLength: 40, autocomplete: "off" });
  const email = element("input", { type: "email", placeholder: "nombre@gmail.com", autocomplete: "off", spellcheck: false });
  const password = element("input", { type: "password", placeholder: "16 letras", autocomplete: "off" });
  const error = element("p", { className: "form-error", hidden: true, role: "alert" });
  const submit = element("button", { type: "submit", textContent: "Conectar", className: "primary" });
  const actions = element("div", { className: "form-actions" });
  if (onCancel) actions.append(button("Cancelar", onCancel, "quiet"));
  actions.append(submit);
  const steps = element(
    "ol",
    {},
    element("li", {}, "Activa la verificación en dos pasos.", button("Abrir", () => act(window.api.openLink("twoStep")), "quiet")),
    element("li", {}, "Crea una contraseña de aplicación.", button("Abrir", () => act(window.api.openLink("appPasswords")), "quiet")),
    element("li", {}, "Pégala aquí."),
  );
  const form = element(
    "form",
    {
      className: "account-form",
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        submit.textContent = "Conectando…";
        const result = await window.api.gmailAdd({ label: label.value, email: email.value, password: password.value });
        submit.disabled = false;
        submit.textContent = "Conectar";
        if (!result.ok) {
          error.textContent = result.error;
          error.hidden = false;
          return;
        }
        form.reset();
        onDone();
      },
    },
    steps,
    field("Nombre", label),
    field("Correo", email),
    field("Contraseña de aplicación", password),
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
    button("Desconectar", () => act(window.api.gmailRemove(email)), "reveal quiet"),
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
  $("gmail-toggle").textContent = gmail.accounts.length ? "Agregar otra cuenta" : "Agregar cuenta de Gmail";
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
  $("vault-add").textContent = notes.vaults.length ? "Agregar otra carpeta" : "Agregar carpeta de notas";
}

$("vault-add").onclick = () => {
  notesKey = null;
  act(window.api.vaultAdd());
};

/* Tasks */

function renderTaskSettings() {
  const { tasks, tailscale } = state;
  const select = $("tasks-host");
  const options = [["", "Esta computadora"], ...tailscale.machines.filter((machine) => !machine.self && machine.os === "macos" && machine.dns).map((machine) => [machine.dns, machine.alias || machine.name])];
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
  const when = client.lastUsedAt ? `Usado ${new Date(client.lastUsedAt).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}` : "Conectado";
  return element(
    "li",
    {},
    element("span", {}, client.name, element("small", { textContent: when })),
    button("Desconectar", () => act(window.api.remoteRevoke(client.id)), "quiet"),
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
    ? "Para usar SMCP desde Claude móvil, Claude web y ChatGPT"
    : count === 1
      ? "1 app conectada"
      : count
        ? `${count} apps conectadas`
        : "Activo, sin apps conectadas";
  $("remote-url").textContent = remote.url ?? "";
  $("remote-code").textContent = remote.pairing?.code ?? "Sin código activo";
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
  $("remote-copy").textContent = "Copiada";
  setTimeout(() => ($("remote-copy").textContent = "Copiar"), 1500);
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
  $("version").textContent = `Versión ${state.version}`;
}

function renderSummary() {
  const { tailscale, whatsapp, clients, policy, gmail } = state;
  if (policy.paused) {
    $("summary").textContent = "En pausa";
    return;
  }
  const online = tailscale.machines.filter((machine) => machine.online && !machine.self).length;
  const apps = clients.items.filter((client) => client.connected).length + state.remote.clients.length;
  const vaults = state.notes.vaults.filter((vault) => vault.enabled).length;
  const active = apps + Number(Boolean(whatsapp.linked)) + gmail.accounts.length + vaults + online;
  $("summary").textContent = active === 1 ? "1 conexión activa" : active ? `${active} conexiones activas` : "Aún sin conexiones";
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
    ...heading("Conecta tu IA con tu computadora", "Para que te ayude con tus chats, archivos y apps. Toma unos minutos y puedes omitir cualquier paso."),
  ],
  claude: () => [
    ...heading("¿Qué apps de IA usas?", "Elige las que tendrán acceso. Después, reinícialas."),
    line(...state.clients.items.map((client) => switchStop(client.name, `ob-${client.id}`, client.connected, setClientFrom(client.id)))),
  ],
  whatsapp: () => {
    const warning = hint("WhatsApp no ofrece este acceso de forma oficial, así que podría restringir tu cuenta. Evita los envíos masivos.");
    if (state.whatsapp.linked) {
      return [
        ...heading("¿Qué puede hacer Claude con WhatsApp?", "WhatsApp ya está vinculado. Elige lo que permites; puedes cambiarlo cuando quieras en Ajustes."),
        ...whatsappChoices("ob-wa"),
        warning,
      ];
    }
    return [
      ...heading("Vincula WhatsApp", "Escanea un código con tu teléfono. Después eliges qué puede hacer Claude con tus chats."),
      line(statusStop(false, "WhatsApp", "Sin vincular", button("Mostrar QR", () => window.api.whatsappLogin(), "primary"))),
      warning,
      $("wa-qr"),
    ];
  },
  gmail: () => {
    const { accounts } = state.gmail;
    const stops = accounts.map(({ label, email }) => statusStop(true, label, label === email ? "Gmail" : email));
    return [
      ...heading("Conecta tu correo", "Puedes agregar todas las cuentas de Gmail que uses. Nada se envía sin tu aprobación."),
      ...(stops.length ? [line(...stops)] : []),
      accountForm({
        onDone: () => {
          onboardingKey = null;
          refresh();
        },
      }),
      hint("La contraseña se guarda cifrada en tu computadora. Si tu cuenta es de empresa, puede que esta opción esté bloqueada."),
    ];
  },
  notes: () => {
    const { vaults } = state.notes;
    return [
      ...heading("Conecta tus notas", "Elige las bóvedas de Obsidian o carpetas de Markdown que tu IA podrá leer. Solo verá las que enciendas."),
      ...(vaults.length ? [line(...vaults.map(vaultStop))] : []),
      button(vaults.length ? "Agregar otra carpeta" : "Elegir carpeta", () => {
        onboardingKey = null;
        act(window.api.vaultAdd());
      }),
      hint("Desde el teléfono solo se pueden leer. Escribir notas funciona únicamente en esta computadora."),
    ];
  },
  tailscale: () => {
    const { tailscale } = state;
    const actions = tailscale.running
      ? []
      : tailscale.installed
        ? [button("Abrir Tailscale", () => act(window.api.openTailscale()), "primary")]
        : [button("Descargar", () => act(window.api.openLink("tailscale")), "primary")];
    const meta = tailscale.running ? `${tailscale.machines.length} equipos en tu red` : tailscale.installed ? "Falta iniciar sesión" : "Sin instalar";
    return [
      ...heading("¿Tienes más computadoras?", "Tailscale las une en una red privada para verlas desde cualquier lugar. Si solo usas esta, omite este paso."),
      line(statusStop(tailscale.running, "Tailscale", meta, ...actions)),
      hint("Es una app aparte, gratuita para uso personal. Instálala, inicia sesión y vuelve: esta pantalla se actualiza sola."),
    ];
  },
  permissions: () => {
    const { accessibility, screen } = state.permissions;
    const activate = (on, pane) => (on ? [] : [button("Activar", () => act(window.api.openPrivacy(pane)))]);
    return [
      ...heading("Permisos de tu Mac", "Solo si quieres que Claude controle apps o tome capturas. Presiona Activar y enciende SMCP en la lista."),
      line(
        statusStop(accessibility, "Accesibilidad", "Para controlar apps", ...activate(accessibility, "accessibility")),
        statusStop(screen, "Grabación de pantalla", "Para tomar capturas", ...activate(screen, "screen")),
      ),
      hint("Después de activar Grabación de pantalla, macOS pide reiniciar SMCP."),
    ];
  },
  done: () => [
    logo(),
    ...heading("Todo conectado", "SMCP queda en la barra superior. Reinicia tu app de IA y prueba con: «Resume mis chats de WhatsApp sin leer»."),
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
  $("ob-progress").textContent = name === "welcome" || name === "done" ? "" : `Paso ${step} de ${middle}`;
  $("ob-back").hidden = step === 0;
  $("ob-skip").hidden = name === "welcome" || name === "done";
  $("ob-next").textContent = name === "welcome" ? "Empezar" : name === "done" ? "Abrir SMCP" : "Continuar";
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
    login === "qr" ? "En tu teléfono: WhatsApp > Dispositivos vinculados > Vincular un dispositivo." : "Preparando el código…";
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
$("copy-diagnostics").onclick = async () => {
  const result = await window.api.copyDiagnostics();
  if (result.ok) $("diag-status").textContent = "Copiado al portapapeles.";
  else showError(result.error);
};
$("restart").onclick = () => window.api.restart();
$("quit").onclick = () => window.api.quit();

let updates = null;

function updateStatusText({ status, latest, message, current }) {
  if (status === "checking") return "Buscando…";
  if (status === "installing" || status === "error") return message;
  if (status === "latest") return "Tienes la versión más reciente.";
  if (status === "available") return `La versión ${latest} está disponible.`;
  return `Tienes la versión ${current}.`;
}

function renderUpdates(value) {
  updates = value;
  const button = $("check-updates");
  const installable = value.status === "available" && value.canInstall;
  const manual = value.status === "available" && !value.canInstall;
  $("update-status").textContent = updateStatusText(value);
  button.textContent = installable ? `Actualizar a ${value.latest}` : manual ? "Descargar" : "Buscar actualizaciones";
  button.disabled = value.status === "checking" || value.status === "installing";
  $("auto-update").checked = value.auto === true;
  $("auto-update-note").textContent =
    window.api && navigator.userAgent.includes("Mac") ? "En Mac, cada versión nueva vuelve a pedir los permisos del sistema." : "";
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
