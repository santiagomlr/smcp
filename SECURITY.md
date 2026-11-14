# Seguridad de SMCP

Auditoría del 14 de noviembre de 2026 contra 20 vectores de ataque comunes en apps modernas.

**Alcance:** todo el repositorio (`src/`, `app/`, `scripts/`). SMCP es una app de Electron con Node 20 y un servidor MCP local. No usa base de datos, Supabase, Clerk, JWT, SAML, GraphQL ni WebSockets.

**Superficie de red real:**

| Puerto | Qué es | Quién llega | Autenticación |
|---|---|---|---|
| 47821 (127.0.0.1) | MCP remoto con OAuth (`app/core/remote.js`) | Internet, por Tailscale Funnel | OAuth 2.1 con PKCE y código de emparejamiento de un solo uso |
| 47823 (127.0.0.1) → 47822 tailnet | Hub de tareas (`app/core/tasks-hub.js`) | Tu tailnet, por Tailscale Serve | Cabecera `Tailscale-User-Login` |
| 47825 (127.0.0.1) → 47824 tailnet | Hub entre computadoras (`app/core/peers.js`) | Tu tailnet, por Tailscale Serve | Cabecera `Tailscale-User-Login` |
| `~/.smcp/smcp.sock` | Ayudante local (`src/helper.js`) | Tu usuario | Permisos `0600` |

## Hallazgos, por severidad

| ID | Hallazgo | CVSS 3.1 | Tipo | Estado |
|---|---|---|---|---|
| SEC-1 | DNS rebinding contra los hubs locales con identidad de Tailscale falsificada | 5.9 Media | Fuga de datos | Corregido |
| SEC-2 | La página de emparejamiento no decía a dónde se enviaba el acceso (phishing de consentimiento) | 5.3 Media | Saltarse la autenticación | Corregido |
| SEC-3 | Rutas bloqueadas comparadas distinguiendo mayúsculas en discos que no las distinguen | 6.5 Media, si se puede explotar | Fuga de datos | Corregido (defensa en profundidad) [NEEDS MANUAL REVIEW] |
| SEC-4 | Cualquiera en internet puede gastar los 5 intentos del código de emparejamiento | 5.3 Media | DoS | Riesgo aceptado |
| SEC-5 | Lista de rutas bloqueadas incompleta | 4.3 Media | Fuga de datos | Ampliada |

Ningún hallazgo permite ejecutar código remoto (RCE).

### SEC-1: DNS rebinding contra los hubs locales

**Riesgo:** CVSS 5.9 (`AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:L/A:N`). Una página web que visites puede leer tus chats de WhatsApp y leer o editar tus tareas.

**Archivos:** `app/core/peers.js:21`, `app/core/tasks-hub.js:148`

Los hubs escuchan en `127.0.0.1` y confían en la cabecera `Tailscale-User-Login`. Tailscale Serve pone esa cabecera, pero el proceso local no puede saber si la petición pasó por Tailscale. Con DNS rebinding, el dominio del atacante pasa a apuntar a `127.0.0.1`. El navegador trata la petición como del mismo origen y deja poner cualquier cabecera. El atacante solo necesita tu login de Tailscale, que suele ser tu correo. Verificado con una prueba de concepto: antes del cambio respondía `200` con los datos y después responde `403`.

**Código vulnerable:**
```js
if (req.method !== "POST" || req.url !== "/peer") return send(404, { error: "Not found." });
// ...
const user = identify(req); // req.headers["tailscale-user-login"], falsificable desde localhost
if (!user || user !== owner) return send(403, ...);
```

**Fix:**
```js
// Los navegadores siempre mandan Origin y Sec-Fetch-Site en un POST; el fetch de Node no manda ninguno.
export const fromBrowser = (req) => Boolean(req.headers.origin || req.headers["sec-fetch-site"]);

if (req.method !== "POST" || req.url !== "/peer") return send(404, { error: "Not found." });
if (fromBrowser(req)) return send(403, { error: "Requests from web pages are not accepted." });
```

`Sec-Fetch-Mode` no sirve como señal: el `fetch` de Node también lo manda, y bloquearlo habría roto las llamadas entre tus computadoras.

**Test:** `test/security-audit.test.js`, pruebas `SEC-1`. Simulan la petición que manda una página con DNS rebinding, con `Origin`, `Sec-Fetch-Site` y la cabecera falsificada, y comprueban que la respuesta es `403` y que el handler nunca corre.

**Riesgo residual [NEEDS MANUAL REVIEW]:** otro usuario del sistema operativo en la misma Mac puede hablar con `127.0.0.1` y falsificar la cabecera. Esto solo importa en Macs compartidas. Para cerrarlo del todo, Serve tendría que apuntar a un socket Unix con `0600` en vez de a un puerto TCP.

### SEC-2: phishing de consentimiento en el emparejamiento

**Riesgo:** CVSS 5.3 (`AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N`). El registro de clientes OAuth es abierto. Un atacante registra un cliente llamado "Claude" con su propio `redirect_uri` y te manda el enlace. Si escribes tu código, el token de acceso le llega al atacante.

**Archivo:** `app/core/remote.js:47`

**Código vulnerable:**
```js
`<p>${escapeHtml(clientName)} wants to access your computer. ...</p>`
```

**Fix:**
```js
`<p>${escapeHtml(clientName)} wants to access your computer. ...</p>
${destination ? `<p>Access will be sent to <strong>${escapeHtml(destination)}</strong>. Enter the code only if you started this from that app.</p>` : ""}`
// destination = redirectHost(params.redirectUri), por ejemplo "claude.ai"
```

**Test:** `test/security-audit.test.js`, prueba `SEC-2`. Registra un cliente con `https://evil.example/cb` y comprueba que la página muestra `evil.example`.

### SEC-3: mayúsculas en las rutas bloqueadas

**Riesgo:** CVSS 6.5 si se puede explotar (`AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`). Un cliente remoto, o una IA con prompt injection, pide `~/.SSH/id_ed25519`. APFS y NTFS ignoran mayúsculas por defecto, así que esa ruta es la misma carpeta que `~/.ssh`.

**Archivo:** `src/tools/files.js:63`

**[NEEDS MANUAL REVIEW]:** `realpath(3)` de macOS normalmente devuelve las mayúsculas tal como están en el disco, y eso ya cerraría el hueco. No se puede comprobar desde Linux. Correr en una Mac: `node -e "require('fs').promises.realpath(require('os').homedir()+'/.SSH').then(console.log)"`. El fix se aplica de todos modos.

**Código vulnerable:**
```js
return blockedPaths().some((blocked) => path === blocked || path.startsWith(blocked + sep));
```

**Fix:**
```js
export function isBlocked(path, { ignoreCase = process.platform === "darwin" || process.platform === "win32" } = {}) {
  const norm = (value) => (ignoreCase ? value.normalize("NFC").toLowerCase() : value);
  const target = norm(path);
  return blockedPaths().some((blocked) => {
    const base = norm(blocked);
    return target === base || target.startsWith(base + sep);
  });
}
```

**Test:** `test/security-audit.test.js`, prueba `SEC-3`.

### SEC-4: DoS del código de emparejamiento

**Riesgo:** CVSS 5.3 (`AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`). `POST /pair` no tiene límite de peticiones. Cualquiera que conozca tu URL de Funnel puede abrir una solicitud y fallar 5 veces, y eso invalida el código activo.

**Archivo:** `app/core/remote.js:176`

**Decisión:** se acepta. El límite global de 5 intentos es justo lo que impide adivinar el código por fuerza bruta: son 40 bits, así que 5 intentos dan una probabilidad de 5 en 2⁴⁰. Si el atacante lo gasta, basta con generar otro código. Si pasa seguido, apaga el Acceso remoto.

### SEC-5: lista de rutas bloqueadas incompleta

**Riesgo:** CVSS 4.3. `file_read` también está disponible desde el celular, y la lista no incluía varios almacenes de credenciales.

**Fix:** se agregaron `~/.git-credentials`, `~/.pypirc`, `~/.password-store`, `~/.zsh_sessions`, `~/.mozilla`, `~/.local/share/keyrings`, `~/.config/google-chrome`, `~/.config/chromium`, y los perfiles de Brave, Edge y Arc.

**[NEEDS MANUAL REVIEW]:** `~/Library/Group Containers` guarda las bases de 1Password, Notas y WhatsApp Desktop, pero no se bloqueó. El antivirus usa la misma lista para saltarse carpetas, así que bloquearla dejaría sin revisar lo que se descarga en WhatsApp Desktop. Hay que decidir por separado.

## Checklist de los 20 vectores

| # | Vector | Estado | Evidencia |
|---|---|---|---|
| 1 | HTTP/2 Rapid Reset | N/A [NEEDS MANUAL REVIEW] | Node solo sirve HTTP/1.1. El HTTP/2 lo termina Tailscale Funnel, que tiene el parche desde Go 1.21.3. Mantén Tailscale actualizado. |
| 2 | Request smuggling | OK [NEEDS MANUAL REVIEW] | El parser llhttp de Node 20+ rechaza `Content-Length` junto con `Transfer-Encoding`. No se puede revisar el proxy de Tailscale desde el código. |
| 3 | Cache poisoning | OK | No hay caché ni CDN. `issuerUrl` sale de `baseUrl` fijo y no de `X-Forwarded-Host`. |
| 4 | Username de 52 caracteres | N/A | No hay usernames. El código de emparejamiento usa `maxlength=12` y `trim().toUpperCase()`, y el servidor solo compara su hash. |
| 5 | SAML bypass | N/A | No hay SAML. |
| 6 | Correo falsificado | OK | Ninguna decisión de autenticación depende del `From`. Los correos se tratan como datos externos y el antivirus revisa sus enlaces y adjuntos. |
| 7 | Reuso del código 2FA | OK | Emparejamiento: un solo uso, 10 min, 5 intentos. Authorization code: un solo uso (se borra al canjearlo), 5 min, PKCE S256. Refresh token: rota en cada uso. |
| 8 | Aliases de GraphQL | N/A | No hay GraphQL. |
| 9 | Confusión de `alg` en JWT | N/A | No hay JWT. Los tokens son opacos de 256 bits (`randomBytes(32)`) y en disco solo se guarda su SHA-256. |
| 10 | Tokens con `Math.random` | OK | No hay ningún `Math.random` en el repo. Se usan `randomBytes` y `randomInt`. |
| 11 | ReDoS | OK | Se revisaron todas las regex. Ninguna tiene cuantificadores anidados sobre input del usuario. `/^(Error:\s*)+/` está anclada y empieza con un literal. |
| 12 | Padding oracle | N/A | No hay AES-CBC. Las contraseñas de Gmail se cifran con `safeStorage` (Llavero del sistema). Las actualizaciones usan Ed25519 más SHA-256. |
| 13 | Prototype pollution | OK | `Object.hasOwn` en `helper.js` y `tasks.js`. Listas permitidas en `peers.js`, `tasks-hub.js` y `policy.js`. `JSON.parse` no contamina el prototipo. |
| 14 | Template injection / XSS | OK | No hay motor de plantillas. El HTML del servidor pasa por `escapeHtml`. La UI no usa `innerHTML` y tiene CSP `script-src 'self'`. Electron corre con `contextIsolation`, `sandbox` y sin `nodeIntegration`. |
| 15 | XXE | OK | No hay parser XML. Los plist se convierten con `plutil -convert json`. |
| 16 | Vistas que se saltan RLS | N/A | No hay Postgres ni Supabase. |
| 17 | IP falsificada en cabecera | Bajo | `trust proxy 1` solo alimenta el rate limit del SDK de OAuth. Un proceso local puede mandar `X-Forwarded-For` falso, pero solo afecta ese rate limit. |
| 18 | Timing attack | OK | El emparejamiento compara hashes con `timingSafeEqual`. Los tokens se buscan por SHA-256 como llave de un mapa, así que no hay comparación byte a byte del secreto. |
| 19 | Secuestro de WebSocket | Corregido (SEC-1) | No hay WebSockets. El equivalente eran los hubs HTTP locales. `/mcp` exige Bearer, así que no admite CSRF. |
| 20 | Homógrafos Unicode | N/A | No hay usernames. El dueño de Tailscale se compara byte a byte con lo que reporta Tailscale. El revisor de URLs ya detecta homógrafos y punycode en enlaces. |

## Cómo reportar una vulnerabilidad

Este repositorio no acepta contribuciones. Reporta por privado con GitHub Security Advisories en `santiagomlr/smcp`.
