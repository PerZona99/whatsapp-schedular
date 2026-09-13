# Dispatch — WhatsApp Scheduler

A web dashboard version of the original terminal-based WhatsApp scheduler.
Same underlying engine (whatsapp-web.js, a cron job checking every minute,
the same `messages.json` format) — but instead of three separate scripts
(`index.js`, `add-message.js`, `list-groups.js`) you get one server with a
browser UI for everything.

## What it does

- Logs into your own WhatsApp account (via a QR code, shown right in the browser)
- Lets you schedule a message — to a person or a group — for a future date/time
- Supports one-off or repeating (daily/weekly) messages
- Supports attaching an image, either uploaded from your computer or a URL
- Shows a live queue of everything scheduled, with status (pending/sent/failed)
- Lets you look up your group IDs without leaving the browser
- Lets you send a queued message immediately with one click

## Setup

1. Make sure Node.js is installed (`node -v`).
2. In this folder, run:
   ```
   npm install
   ```
3. Start it:
   ```
   npm start
   ```
4. Open **http://localhost:3000** in your browser.
5. Scan the QR code shown on the page with WhatsApp on your phone:
   Settings → Linked devices → Link a device.
6. Once connected, the dashboard appears and you can start scheduling.

Your login is saved to a `.wwebjs_auth` folder after the first scan, so you
won't need to scan again unless you delete that folder or unlink the device.

## Running it 24/7

Same idea as the original tool: this only sends messages while the server
process is running. For always-on scheduling, put it on a small VPS or a
Raspberry Pi and keep it alive with PM2:

```
npm install -g pm2
pm2 start server.js --name dispatch
pm2 save
```

## Building a Windows installer (so anyone can run it, no Node required)

This repo includes an Electron wrapper, so it can also be built into a
normal `Dispatch-Setup-x.x.x.exe` installer. Each person who installs it
runs their own copy, on their own machine, and scans the QR code with
their own phone — sessions are never shared between installs.

The easiest way to build it is to let GitHub do it for you (building a
Windows `.exe` really wants to happen on an actual Windows machine, which
a GitHub Actions runner provides for free):

1. Push this repo to GitHub (see below if you haven't already).
2. Go to the **Actions** tab → **Build Windows installer** → **Run workflow**.
3. Wait for it to finish (a few minutes), then open the completed run and
   download the **Dispatch-Windows-Installer** artifact — that's your `.exe`.
4. Send that file to whoever wants to use it. They double-click it, click
   through the installer, launch **Dispatch** from the Start Menu, and
   scan the QR code with their own phone.

Their session and scheduled-message queue are stored in
`%APPDATA%\Dispatch` on their machine — private to them, untouched by
future reinstalls or updates.

To build it locally instead (only works on a Windows machine):
```
npm install
npm run dist
```
The installer appears in the `dist/` folder.

## Notes

- This uses `whatsapp-web.js`, an unofficial library that automates the
  WhatsApp Web interface. It isn't sanctioned by Meta for business/bulk
  messaging use — treat it as a personal-use / learning tool, not a mass
  messaging system.
- `messages.json` uses the same shape as the original CLI tool, so if
  you're migrating from it you can just copy your existing file over
  (and your `.wwebjs_auth` folder, to skip re-scanning the QR code).
- Uploaded images are stored in `public/uploads/` and referenced from
  `messages.json` as `/uploads/<filename>` — don't delete a file from
  that folder while its message is still pending.
