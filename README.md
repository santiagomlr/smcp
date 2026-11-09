# SMCP

App personal para macOS que conecta a tu IA con tu computadora: WhatsApp, Gmail, notas de Obsidian, tareas, archivos, terminal y control de apps. Funciona sin cuenta de SMCP, sin servidores propios y sin telemetría.

Vive en la barra superior y se conecta a Claude Code, Claude Desktop, Cursor, VS Code y Antigravity. Claude móvil, Claude web y ChatGPT entran por una URL privada.

Usa [wacli](https://github.com/openclaw/wacli) (MIT), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) y APIs públicas. Puedes descargar SMCP y usarlo gratis según la [licencia](LICENSE); este repositorio no acepta contribuciones.

## Qué incluye

| Área | Herramientas | Desde el teléfono |
|---|---|---|
| WhatsApp | `whatsapp_status`, `whatsapp_list_chats`, `whatsapp_read_messages`, `whatsapp_search_messages`, `whatsapp_search_contacts`, `whatsapp_sync`, `whatsapp_send`, `whatsapp_transcribe_audio` | Todo menos enviar y escuchar audios |
| Gmail, varias cuentas | `gmail_list_accounts`, `gmail_search`, `gmail_read`, `gmail_send` | Todo menos enviar |
| Notas, Obsidian o Markdown | `notes_list_vaults`, `notes_search`, `notes_recent`, `notes_read`, `notes_write` | Todo menos escribir |
| Tareas | `tasks_available`, `tasks_search`, `tasks_list_projects`, `tasks_claude_queue`, `tasks_hygiene`, `tasks_forecast`, `tasks_review_list`, `tasks_mark_reviewed`, `tasks_create`, `tasks_update`, `tasks_append_note`, `tasks_complete` | Solo lectura |
| Archivos | `file_list`, `file_read`, `file_search`, `file_write` | Todo menos escribir |
| Terminal | `run_command` | No disponible |
| Apps | `app_list`, `window_list`, `app_focus`, `ui_read_tree`, `ui_click`, `ui_type`, `ui_key`, `screenshot` | No disponible |

Terminal y Apps empiezan apagados. Se encienden en Ajustes, y con Terminal encendida la IA podría enviar mensajes sin pasar por la ventana de confirmación.

Al vincular WhatsApp eliges qué puede hacer la IA: **leer tus chats** y **escribir con tu aprobación**. Leer empieza encendido y escribir, apagado. Se cambia en Ajustes y aplica en la siguiente llamada, también desde el teléfono. Escribir encendido nunca evita la ventana de confirmación. Las instalaciones anteriores a esta opción conservan ambas encendidas.

**Escuchar audios** es gratis y empieza apagado. Convierte tus notas de voz en texto con whisper.cpp en tu computadora, sin cuentas ni claves; a tu IA solo le llega el texto, y el audio temporal se borra al terminar. La primera vez descarga un modelo abierto de unos 490 MB y comprueba que llegó completo. Necesita leer tus chats encendido y una versión de macOS que abra el formato de audio de WhatsApp; si la tuya no puede, la opción no aparece.

## Uso

Abre **SMCP**. La primera vez, el onboarding guía cada paso y todos se pueden omitir.

- **Barra superior:** tareas para hoy, captura rápida, dispositivos y conexiones. El punto verde indica activo; el rojo, en pausa.
- **Conexiones:** apps de IA, acceso remoto, WhatsApp, Gmail, notas y máquinas de Tailscale.
- **Ajustes:** pausa, solo lectura, permisos por área, permisos de macOS y dónde viven tus tareas.
- **Tareas ↗:** Hoy, Bandeja, Próximo y tus proyectos. Escribe y da Enter para agregar. Cada tarea indica quién la hace, **Yo** o **Claude**.

## Instalación desde el código

Requiere Node 20 o posterior. El `wacli` oficial requiere macOS 15 o posterior.

```bash
npm install
```

```bash
npm run whatsapp:install
```

```bash
npm run whatsapp:audio-install
```

```bash
npm run icons
```

```bash
npm run dist:mac
```

La app queda en `~/Library/Caches/smcp-build/mac-arm64/SMCP.app`. Cópiala a `/Applications`. `npm run dist:win` genera los `.exe`; en Windows la app funciona como panel, sin servidor MCP local.

Para desarrollo, `npm run app` abre la app sin empaquetar y `npm test` corre las pruebas.

## Dónde se guardan tus datos

Todo está en `~/.smcp/`, con permisos solo para tu usuario.

| Archivo | Contenido |
|---|---|
| `tasks.json` | Tareas, con respaldo diario en `tasks.json.bak` |
| `wacli/` | Sesión y mensajes de WhatsApp, sin cifrar |
| `whisper/` | Modelo para escuchar audios, si lo encendiste |
| `gmail.json` | Cuentas, con contraseñas cifradas por el llavero del sistema |
| `vaults.json` | Bóvedas encendidas |
| `config.json` | Pausa, solo lectura, permisos por área y lo que la IA puede hacer con WhatsApp |
| `remote.json` | Apps remotas conectadas, con sus tokens solo como hash |

Lo que la IA lee se envía al proveedor de esa IA.

## Seguridad

- **Envíos:** cada WhatsApp y cada correo abre una ventana de macOS con destinatario y texto. Solo sale si presionas Enviar. No se puede desactivar por configuración.
- **Acceso remoto:** usa [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). La URL es pública, pero exige OAuth y un código de emparejamiento que solo aparece en la app: sirve una vez, dura 10 minutos y se invalida tras 5 intentos.
- **Tareas entre computadoras:** van por Tailscale Serve, sin abrir el firewall, y solo aceptan tu propia cuenta de Tailscale.
- **Notas:** apagadas hasta que las enciendes. Las herramientas no salen de la bóveda ni entran a carpetas ocultas.
- **Archivos:** bloquean credenciales y `~/.smcp`. Es una barrera contra accidentes: `run_command` no tiene ese límite.
- **No dejes en "permitir siempre"** `run_command`, `ui_click`, `ui_type` ni `ui_key`. Un mensaje malicioso podría intentar engañar a la IA para usarlas.

## Limitaciones

- WhatsApp funciona con `wacli`, que no es un cliente oficial, así que tu cuenta podría sufrir restricciones. Evita los envíos masivos.
- Gmail usa contraseñas de aplicación, que dan acceso amplio a la cuenta y algunas empresas bloquean.
- El acceso remoto requiere que la computadora esté encendida, sin dormir y con SMCP abierta.
- La app está firmada solo para pruebas. macOS advierte al abrirla si se descarga, y cada versión nueva vuelve a pedir Accesibilidad, Grabación de pantalla y Calendario.
- Windows muestra una advertencia de SmartScreen.
