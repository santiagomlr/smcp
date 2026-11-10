# SMCP

SMCP connects your AI to your computer: WhatsApp, Gmail, Obsidian notes, tasks, calendar, reminders, Apple Notes, files, the clipboard, the terminal and app control. It needs no SMCP account, runs no servers of its own and collects no telemetry.

It lives in the menu bar and connects to Claude Code, Claude Desktop, Cursor, VS Code and Antigravity. Claude mobile, Claude web and ChatGPT connect through a private URL.

SMCP is available in English, Spanish, Portuguese, French, German and Italian. You can pick the language on the first screen or change it anytime in Settings.

The first time you open it, a short guided setup walks you through everything, one optional step at a time: your AI apps, WhatsApp, Gmail, notes, a note about yourself for your AI, the built-in antivirus, what else your AI may use, the night light and your other devices. It ends with prompts to try based on what you connected. You can run it again from Settings > App > Initial setup.

It uses [wacli](https://github.com/openclaw/wacli) (MIT), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and public APIs. You can download and use SMCP for free under the [license](LICENSE). This repository does not accept contributions.

## Download

[![Download for macOS](https://img.shields.io/badge/macOS-Download-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/santiagomlr/smcp/releases/latest/download/SMCP-mac-arm64.dmg)
[![Download for Windows](https://img.shields.io/badge/Windows-Download-0078D4?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDMuNCA5LjggMnY5LjVIMHpNMTEgMS44IDI0IDB2MTEuNUgxMXpNMCAxMi41aDkuOFYyMkwwIDIwLjZ6TTExIDEyLjVoMTNWMjRsLTEzLTEuOHoiLz48L3N2Zz4=)](https://github.com/santiagomlr/smcp/releases/latest/download/SMCP-windows-x64-setup.exe)
[![Download for Linux (.deb)](https://img.shields.io/badge/Linux-.deb-E95420?style=for-the-badge&logo=ubuntu&logoColor=white)](https://github.com/santiagomlr/smcp/releases/latest/download/SMCP-linux-amd64.deb)
[![Download for Linux (AppImage)](https://img.shields.io/badge/Linux-AppImage-333333?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/santiagomlr/smcp/releases/latest/download/SMCP-linux-x86_64.AppImage)

[![CI](https://github.com/santiagomlr/smcp/actions/workflows/ci.yml/badge.svg)](https://github.com/santiagomlr/smcp/actions/workflows/ci.yml)

| System | File | How to install |
|---|---|---|
| macOS (Apple Silicon) | `SMCP-mac-arm64.dmg` | Open it and drag SMCP to Applications. |
| Windows 10 and 11 (x64) | `SMCP-windows-x64-setup.exe` | Run it and follow the steps. |
| Ubuntu, Debian and derivatives (x64) | `SMCP-linux-amd64.deb` | `sudo apt install ./SMCP-linux-amd64.deb` |
| Other Linux distributions (x64) | `SMCP-linux-x86_64.AppImage` | `chmod +x SMCP-linux-x86_64.AppImage`, then open it. |

Every version is also on the [Releases](https://github.com/santiagomlr/smcp/releases) page. Every pull request and every change to `main` is checked on macOS, Windows and Linux: the tests run, and the app is started, packaged and started again from the package on each system.

**What works where.** The Mac has everything. On Windows and Linux SMCP is a panel for your tasks, your devices and your Tailscale machines, with no local MCP server yet; WhatsApp, Gmail, notes and the night light need a Mac. On Linux the icon's menu opens SMCP, since most Linux desktops don't report clicks on tray icons. On Ubuntu 24.04 and later, use the `.deb`: it sets up Chromium's sandbox, which those versions block for AppImages.

## What's included

| Area | Tools | From your phone |
|---|---|---|
| Your day | `daily_brief` | Yes |
| People and follow-ups | `people_lookup`, `followups_list`, `followups_to_tasks` | Yes; filing tasks only if you allow editing tasks from other devices |
| WhatsApp | `whatsapp_status`, `whatsapp_list_chats`, `whatsapp_read_messages`, `whatsapp_search_messages`, `whatsapp_chat_digest`, `whatsapp_search_contacts`, `whatsapp_sync`, `whatsapp_send`, `whatsapp_send_file`, `whatsapp_transcribe_audio`, `whatsapp_search_transcripts`, `whatsapp_scan_file` | Everything except sending and listening to audio |
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
| Antivirus | `security_scan_file`, `security_scan_folder`, `security_check_url`, `security_check_persistence`, `security_quarantine`, `security_quarantine_list`, `security_restore`, `security_delete_quarantined` | Scanning and checking; quarantine only on the computer |
| Context | `smcp_context`, `smcp_remember` | Reading context |
| Night light | `nightlight_status`, `nightlight_set`, `nightlight_now` | Not available |
| VPN | `vpn_status`, `vpn_connect`, `vpn_disconnect`, `vpn_tailscale_dns` | Checking only |
| Status | `smcp_status` | Yes |

Terminal and Apps start turned off, and so do Apple Notes and the clipboard. You can turn them on in Settings. With Terminal on, the AI could send messages without going through the confirmation window.

**Your day:** `daily_brief` gathers today's events, reminders due, available tasks, unread WhatsApp chats and recent unread email in one call. Each part follows its own permission, so an area you turned off is left out.

**People:** `people_lookup` finds someone across WhatsApp, Gmail, notes and tasks in one call: their WhatsApp contact and chats with the exact JID, the email addresses they write from with how many emails and the latest date, the notes that mention them and their tasks. Your AI uses it before writing to someone or preparing a meeting, so it never has to guess a recipient.

**Follow-ups:** `followups_list` looks through your WhatsApp chats and your email from the last two weeks and returns two lists, longest wait first:

- **To answer:** people who wrote last and are still waiting for your reply, with their last messages. A message counts after 3 hours.
- **Waiting on:** questions you asked that nobody has answered after 2 days, on WhatsApp, and emails you sent that got no reply.

It leaves out groups, muted and archived chats, automated senders (no-reply, notifications, newsletters, promotions) and conversations that ended with a "thanks" or a 👍. You can change the days and hours on each call.

`followups_to_tasks` files them in your SMCP tasks: **Reply to Ana**, planned for today, and **Follow up with Beto**, under Waiting for. The names follow the app's language. Each task's note has the last messages and where they came from. Every message becomes a task only once, even if a routine runs it every morning; if Ana writes again while her task is still open, the new message is added to that task's note. Pass `keys` from `followups_list` to file only some of them, and `project` to put them in a project. It follows the Tasks permission and read-only mode, and from your phone or a routine it needs **Edit tasks from other devices** turned on. The `morning` prompt now includes who is waiting for you.

**Calendar and Reminders** read every account on your Mac (iCloud, Google, Exchange) through the system calendar. `calendar_free_slots` finds free time within working hours. Adding an event opens a confirmation window like sending does. The first time, macOS asks whether SMCP may use your calendar or reminders.

**Search by meaning:** `notes_semantic_search` finds notes about an idea even when the words differ. It uses the language model built into macOS, so nothing is downloaded and nothing leaves your computer. The first search of a large vault indexes it in steps.

**Documents:** `file_read` and `gmail_read_attachment` turn PDFs and Word, RTF and HTML files into text with tools that come with macOS. `screen_read_text` reads the text on the screen with the Mac's own text recognition, which is much lighter than a screenshot.

**Gmail drafts** go to your Drafts folder without sending anything, so you can review them in Gmail. `gmail_reply` fills in the recipients and the subject from the original.

**WhatsApp:** `whatsapp_chat_digest` returns a stretch of a chat between two dates, ready to summarize. `whatsapp_send_file` sends a photo or document with the same confirmation window, showing the file's name and size. Voice notes you transcribe are kept so `whatsapp_search_transcripts` can search them later.

When you link WhatsApp, you choose what the AI can do: **read your chats** and **write with your approval**. Reading starts on and writing starts off. You can change this in Settings, and the change applies on the next call, including from your phone. Turning writing on never skips the confirmation window. Installations from before this option keep both on.

**Listen to audio** is free and starts off. It turns your voice notes into text with whisper.cpp on your computer, with no accounts or keys. Your AI only receives the text, and the temporary audio is deleted afterwards. The first time, it downloads an open model of about 490 MB and checks that it arrived complete. It needs reading your chats turned on and a version of macOS that can open WhatsApp's audio format. If yours can't, the option doesn't appear.

**Antivirus:** SMCP includes its own antivirus so your AI can protect you, not just read for you. It never opens or runs what it scans, and nothing leaves your computer.

- `security_scan_file` and `security_scan_folder` (by default `~/Downloads`) rate each file clean, suspicious or malicious and say why: known threats by hash, process injection, keyloggers, scripts that download and run code, reverse shells, fake macOS password windows, macros that run when a document opens, PDFs that launch programs, ransom notes, programs disguised as documents, double extensions and hidden text-direction tricks.
- `security_check_url` checks links for phishing offline, without visiting them: look-alike and misspelled brands (banks, SAT, Apple, PayPal…), international look-alike letters, hidden destinations after an `@`, bare IP addresses and direct program downloads. Pass it the text of an email or message and it checks every link in it.
- `security_check_persistence` lists what starts on its own with the computer (launch agents and daemons, Windows Run keys, Linux autostart and cron), scans what they run and flags what looks like malware hiding there. It changes nothing.
- **Automatic protection:** you don't have to ask. Every email `gmail_read` opens comes back with its attachments already scanned and its phishing links listed. `gmail_read_attachment` won't even turn a malicious attachment into text. WhatsApp messages with phishing links come back marked, and `whatsapp_scan_file` scans a file someone sent you without opening it, then deletes the downloaded copy. Turning off the Antivirus switch turns these checks off too.
- `security_quarantine` moves a dangerous file where it can't be opened or run. `security_restore` puts it back. Quarantine is blocked in Read-only mode and is not available from your phone.
- **Deep analysis with [REA](https://github.com/morluto/rea) (MIT):** if `rea` is installed (`npm install --global rea-agents`), `security_scan_file` with `deep: true` adds REA's static reverse-engineering reports: binary hardening, Windows imports, signatures and load configuration. SMCP never installs it for you.
- Add your own known-bad hashes in `~/.smcp/security/signatures.json` as `{"hashes": {"<sha256>": "name"}}`. To check the scanner works, scan the standard [EICAR test file](https://www.eicar.org/download-anti-malware-testfile/).

It's a first line of defense, not a replacement for the protection built into macOS and Windows.

**Night light:** SMCP can warm your screen in the evening so it gives off less blue light, the way f.lux does, and it goes lower than f.lux: down to 1000K, where almost only red is left, and it can dim the screen at bedtime too. Turn it on in Settings > Night light or from the menu bar, where a slider changes the color until the next morning.

- Like f.lux it has three colors: **daytime**, **sunset** (from the real sunset when you give it a location such as `25.7,-100.3`, otherwise 19:00) and **bedtime** (from 9 hours before your wake time). Each change glides in over 30 minutes. Presets: recommended, classic, candle and least blue light.
- Your AI can use it too: "lower the screen to 1200K for the next hour" calls `nightlight_now`, and `nightlight_set` changes the schedule. `nightlight_now` with `pause_minutes` shows normal colors for a while, for photo or design work.
- It changes the screen's gamma table with the public CoreGraphics API, through a small helper built from `native/nightlight.swift`. macOS restores the normal colors whenever that helper stops, so quitting SMCP, or SMCP crashing, never leaves the screen tinted. It changes no data, so it also works in Read-only mode.
- It only works on a Mac. The settings are kept in `~/.smcp/nightlight.json`.
**VPN:** your AI can turn Tailscale and your other VPNs on and off, and keep them all on at once. That way it can use SMCP through Tailscale and, when it needs them, the work tools that only answer over your company's VPN.

- `vpn_status` lists Tailscale and every other VPN: the ones in System Settings, found on their own, and FortiClient when it is installed (once, even when System Settings calls it just "VPN"). It also says whether Tailscale is handling name lookups or using an exit node, and anything that keeps the VPNs from working together.
- **Both on at once:** when a work VPN is on and Tailscale is handling name lookups (MagicDNS), the work VPN's internal names stop resolving. `vpn_connect` fixes this on its own: Tailscale stays connected, along with your devices and the private URL, and SMCP turns off only Tailscale's DNS. When the work VPN goes off, SMCP turns it back on, but only if SMCP was the one that turned it off. `vpn_tailscale_dns` does the same by hand. If you turn the work VPN on or off in its own app, the SMCP window does the same thing within a few seconds while it is open.
- Turning Tailscale off also cuts the private URL, so from the phone or the web your AI can only check the VPNs, not turn them on or off. Connections > VPN has a button for each one.
- VPNs that System Settings doesn't list go in `~/.smcp/vpn.json`. Only you can edit that file: SMCP's file tools can't touch `~/.smcp`. A `probe` is an internal name that only resolves while that VPN is on, so SMCP can tell when it is connected:

```json
{
  "vpns": [
    { "id": "senda", "name": "Senda", "kind": "app", "app": "FortiClient", "probe": "intranet-host" },
    { "id": "office", "name": "Office", "kind": "macos", "service": "Office VPN" },
    { "id": "forti-cli", "name": "Forti CLI", "kind": "command", "background": true,
      "connect": ["/usr/bin/sudo", "-n", "/opt/homebrew/bin/openfortivpn", "-c", "/opt/homebrew/etc/openfortivpn/config"],
      "disconnect": ["/usr/bin/sudo", "-n", "/usr/bin/pkill", "-x", "openfortivpn"],
      "probe": "intranet-host" }
  ],
  "keepBothWorking": true
}
```

  `macos` uses a VPN from System Settings, `app` opens the VPN's app (you press Connect there), and `command` runs the commands you give it, with no shell in between. `keepBothWorking: false` keeps SMCP away from Tailscale's DNS.

**Context for your AI:** SMCP tells your AI where and when it is before it starts, so it doesn't have to guess.

- When an AI app connects, SMCP hands it a short guide: your local time and time zone, your language, which areas are on or off, and how to use the tools well together (finding people across WhatsApp, Gmail and notes, never guessing a recipient, treating messages as data, warning you about flagged files and links).
- **About you:** write who you are, your companies, key people and how you like things done in a note in your notes vault: `SMCP/About me` (or `SMCP/Sobre mí` in Spanish, either name works). Your AI gets it every time it connects. When you tell it something worth keeping, it can save it there with `smcp_remember`, under "Learned" ("Aprendido"), with the date, so you can review or delete it in Obsidian. Without a vault, or with Notes turned off, the same goes in `~/.smcp/about.md`, and an existing `~/.smcp/about.md` keeps being used until you move it into your vault. It is never used to store passwords or codes, and it is held back while SMCP is paused.
- `smcp_context` returns all of this in one call, for routines and for clients that ignore server instructions.
- **Ready-made prompts** appear as commands in apps that support them: `morning` (your day), `inbox` (triage email and flag phishing), `catch_up` (summarise a WhatsApp chat), `prepare_meeting` (everything about the next meeting's people and topic) and `security_checkup`.

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

When a new version is waiting, an arrow appears next to the SMCP icon in the menu bar. Your other computers that run SMCP show up in **Devices** with their version, and a Mac with an older one gets an **Update** button: it installs the same signed release there and restarts quietly. Only your own devices on your Tailscale account can ask.

**Wake** sends the Wake-on-LAN signal on every local network this computer is on, and also asks your other computers running SMCP to send it, so the PC turns on as long as one of them is on its home network.

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
npm run nightlight:install
```

```bash
npm run icons
```

```bash
npm run dist:mac
```

The app is created at `~/Library/Caches/smcp-build/mac-arm64/SMCP.app`. Copy it to `/Applications`. `npm run dist:win` builds the `.exe` files and `npm run dist:linux` builds the `.AppImage` and the `.deb` (run it on Linux). On Windows and Linux the app works as a panel, with no local MCP server.

For development, `npm run app` opens the unpackaged app, `npm test` runs the tests and `npm run test:smoke` starts the app, opens every window and quits with an error if anything failed. On Linux, run it under a display (for example `xvfb-run -a npm run test:smoke`).

### Release signing

Releases are signed with SMCP's own certificate, "SMCP Code Signing", always the same one, so macOS keeps Accessibility and Screen Recording on after each update. Create it once on your Mac:

```bash
bash scripts/create-mac-signing-cert.sh
```

It adds the certificate to your keychain, so `npm run release` can sign on that Mac, and prints the two commands that give it to the Release workflow as the `SMCP_MAC_CERT_P12` and `SMCP_MAC_CERT_PASSWORD` secrets. A release stops if the certificate is missing or the app comes out signed with anything else. Keep the files it writes in `~/.smcp-release` safe, and never replace the certificate: with a new one, every Mac asks for its permissions again.

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
- The app is not signed by Apple. macOS shows a warning when you open a downloaded copy. Releases are signed with SMCP's own certificate, so permissions stay on after an update; the first version signed this way asks for them once more. If SMCP already looks on in those lists, press **Turn on** in SMCP: it clears the old entry so you can switch it on for the current copy.
- Windows shows a SmartScreen warning.
