# SMCP

SMCP connects your AI to your computer: WhatsApp, Gmail, Obsidian notes, tasks, calendar, reminders, Apple Notes, files, the clipboard, the terminal and app control. It needs no SMCP account, runs no servers of its own and collects no telemetry.

It lives in the menu bar and connects to Claude Code, Claude Desktop, Cursor, VS Code and Antigravity. Claude mobile, Claude web and ChatGPT connect through a private URL.

SMCP is available in English and Spanish. You can change the language in Settings.

It uses [wacli](https://github.com/openclaw/wacli) (MIT), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and public APIs. You can download and use SMCP for free under the [license](LICENSE). This repository does not accept contributions.

## Download

Get the latest version from [Releases](https://github.com/santiagomlr/smcp/releases/latest): the `.dmg` for Apple Silicon Macs or the `Setup .exe` for Windows.

## What's included

| Area | Tools | From your phone |
|---|---|---|
| Your day | `daily_brief` | Yes |
| WhatsApp | `whatsapp_status`, `whatsapp_list_chats`, `whatsapp_read_messages`, `whatsapp_search_messages`, `whatsapp_chat_digest`, `whatsapp_search_contacts`, `whatsapp_sync`, `whatsapp_send`, `whatsapp_send_file`, `whatsapp_transcribe_audio`, `whatsapp_search_transcripts` | Everything except sending and listening to audio |
| Gmail, multiple accounts | `gmail_list_accounts`, `gmail_search`, `gmail_read`, `gmail_read_attachment`, `gmail_send`, `gmail_reply`, `gmail_draft` | Everything except sending and drafts |
| Notes, Obsidian or Markdown | `notes_list_vaults`, `notes_search`, `notes_semantic_search`, `notes_recent`, `notes_read`, `notes_write` | Everything except writing |
| Tasks | `tasks_available`, `tasks_search`, `tasks_list_projects`, `tasks_claude_queue`, `tasks_hygiene`, `tasks_forecast`, `tasks_review_list`, `tasks_mark_reviewed`, `tasks_create`, `tasks_update`, `tasks_append_note`, `tasks_complete` | Reading, and editing if you turn it on |
| Calendar | `calendar_list_calendars`, `calendar_list_events`, `calendar_free_slots`, `calendar_create_event` | Everything except adding events |
| Reminders | `reminders_list_lists`, `reminders_list`, `reminders_create`, `reminders_complete` | Read only |
| Apple Notes | `applenotes_search`, `applenotes_recent`, `applenotes_read` | Yes |
| Files | `file_list`, `file_read`, `file_search`, `file_write` | Everything except writing |
| Clipboard | `clipboard_read`, `clipboard_write` | Not available |
| Terminal | `run_command` | Not available |
| Apps | `app_list`, `window_list`, `app_focus`, `ui_read_tree`, `ui_click`, `ui_type`, `ui_key`, `screenshot`, `screen_read_text` | Not available |
| Status | `smcp_status` | Yes |

Terminal and Apps start turned off, and so do Apple Notes and the clipboard. You can turn them on in Settings. With Terminal on, the AI could send messages without going through the confirmation window.

**Your day:** `daily_brief` gathers today's events, reminders due, available tasks, unread WhatsApp chats and recent unread email in one call. Each part follows its own permission, so an area you turned off is left out.

**Calendar and Reminders** read every account on your Mac (iCloud, Google, Exchange) through the system calendar. `calendar_free_slots` finds free time within working hours. Adding an event opens a confirmation window like sending does. The first time, macOS asks whether SMCP may use your calendar or reminders.

**Search by meaning:** `notes_semantic_search` finds notes about an idea even when the words differ. It uses the language model built into macOS, so nothing is downloaded and nothing leaves your computer. The first search of a large vault indexes it in steps.

**Documents:** `file_read` and `gmail_read_attachment` turn PDFs and Word, RTF and HTML files into text with tools that come with macOS. `screen_read_text` reads the text on the screen with the Mac's own text recognition, which is much lighter than a screenshot.

**Gmail drafts** go to your Drafts folder without sending anything, so you can review them in Gmail. `gmail_reply` fills in the recipients and the subject from the original.

**WhatsApp:** `whatsapp_chat_digest` returns a stretch of a chat between two dates, ready to summarize. `whatsapp_send_file` sends a photo or document with the same confirmation window, showing the file's name and size. Voice notes you transcribe are kept so `whatsapp_search_transcripts` can search them later.

When you link WhatsApp, you choose what the AI can do: **read your chats** and **write with your approval**. Reading starts on and writing starts off. You can change this in Settings, and the change applies on the next call, including from your phone. Turning writing on never skips the confirmation window. Installations from before this option keep both on.

**Listen to audio** is free and starts off. It turns your voice notes into text with whisper.cpp on your computer, with no accounts or keys. Your AI only receives the text, and the temporary audio is deleted afterwards. The first time, it downloads an open model of about 490 MB and checks that it arrived complete. It needs reading your chats turned on and a version of macOS that can open WhatsApp's audio format. If yours can't, the option doesn't appear.

## Built for scheduled routines

A routine that runs at night with nobody watching needs to know what will work before it starts, and to keep going when one part is down.

- **Check first:** `smcp_status` says, area by area, what works right now and why something doesn't (paused, turned off, no account linked, app closed). It answers even when SMCP is paused, so a routine can stop with a clear reason instead of failing halfway.
- **One area failing doesn't stop the rest.** Each tool fails on its own, with a message that says what to do.
- **No account, no monthly limit, one name.** There is no SMCP account to lose and no cap on calls, and every tool lives under one server, `smcp`.
- **Reading tasks with the app closed:** if SMCP.app doesn't respond, task reads come straight from the saved list, with a note saying so. Writing still waits for the app, so there is never a second list.
- **Tasks from the phone, the web and routines:** turn on **Edit tasks from other devices** in Settings and remote clients can create, change and complete tasks. It starts off, it only touches SMCP's task list, and Read-only still blocks it.
- **No duplicates:** `tasks_create` rejects a pending task with the same name in the same project, ignoring accents, case and punctuation, and returns the existing task's id. `allow_duplicate: true` skips the check.
- **Accents:** task, note and file searches ignore accents and treat macOS file names (NFD) the same as typed text (NFC).
- **Long commands:** `run_command` asks for no confirmation and accepts up to 600 seconds.

## Usage

Open **SMCP**. The first time, setup walks you through each step, and you can skip any of them.

- **Menu bar:** today's tasks, quick capture, devices and connections. A green dot means active; red means paused.
- **Connections:** AI apps, remote access, WhatsApp, Gmail, notes and Tailscale machines.
- **Settings:** language, pause, read only, permissions by area, recent activity, macOS permissions, updates and where your tasks live.
- **Tasks ↗:** Today, Inbox, Upcoming and your projects. Type and press Enter to add. Each task shows who does it, **Me** or **Claude**.

## Updates

SMCP can check for new versions from Settings, and asks whether you want it to update automatically. Every update is verified against a signature before it is installed. On Windows, SMCP tells you about a new version and takes you to the download.

## Build from source

Requires Node 20 or later. The official `wacli` requires macOS 15 or later.

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

The app is created at `~/Library/Caches/smcp-build/mac-arm64/SMCP.app`. Copy it to `/Applications`. `npm run dist:win` builds the `.exe` files. On Windows the app works as a panel, with no local MCP server.

For development, `npm run app` opens the unpackaged app and `npm test` runs the tests.

## Where your data is stored

Everything is in `~/.smcp/`, with permissions for your user only.

| File | Contents |
|---|---|
| `tasks.json` | Tasks, with a daily backup in `tasks.json.bak` |
| `wacli/` | WhatsApp session and messages, unencrypted |
| `whisper/` | Audio model, if you turned it on |
| `transcripts.jsonl` | Text of the voice notes you transcribed. Deleted when you disconnect WhatsApp |
| `notes-index.json` | Search-by-meaning index of your vaults, with short previews. A vault you turn off leaves it |
| `audit.jsonl` | Recent activity: which tool ran, when, from where and how it ended. Never what it read or sent |
| `gmail.json` | Accounts, with passwords encrypted by the system keychain |
| `vaults.json` | Vaults that are turned on |
| `config.json` | Pause, read only, permissions by area, what the AI can do with WhatsApp, and whether other devices can edit tasks |
| `remote.json` | Connected remote apps, with their tokens stored only as hashes |

Whatever the AI reads is sent to that AI's provider.

## Security

- **Sending:** every WhatsApp message, file and email opens a macOS window showing the recipient and the text or file. It only goes out if you press Send. Adding a calendar event asks the same way. This can't be turned off in settings.
- **Recent activity:** Settings lists the last calls your AI made, with the time, whether it came from this computer or remotely, and whether it worked or was blocked. You can clear it at any time.
- **Clipboard:** off until you turn it on, because it often holds passwords and codes.
- **Remote access:** uses [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). The URL is public, but it requires OAuth and a pairing code that only appears in the app. The code works once, lasts 10 minutes and is invalidated after 5 attempts.
- **Tasks across computers:** go through Tailscale Serve, without opening the firewall, and only accept your own Tailscale account.
- **Notes:** off until you turn them on. The tools can't leave the vault or enter hidden folders.
- **Files:** credentials and `~/.smcp` are blocked, for reading and for sending through WhatsApp. This is a barrier against accidents: `run_command` doesn't have this limit.
- **Don't set** `run_command`, `ui_click`, `ui_type` or `ui_key` **to "always allow".** A malicious message could try to trick the AI into using them.

## Limitations

- WhatsApp works through `wacli`, which isn't an official client, so your account could face restrictions. Avoid bulk sending.
- Gmail uses app passwords, which give broad access to the account and which some companies block.
- Remote access requires the computer to be on, awake and running SMCP.
- The app is not signed by Apple. macOS shows a warning when you open a downloaded copy, and every new version asks again for Accessibility, Screen Recording and Calendar.
- Windows shows a SmartScreen warning.
