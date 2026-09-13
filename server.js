// server.js
// Run with: node server.js
// This replaces the old terminal scripts (index.js / add-message.js /
// list-groups.js) with one process that runs the WhatsApp engine AND
// serves a web dashboard for it, at http://localhost:3000 by default.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const cron = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// When running as a plain Node app, everything lives next to this file.
// When running inside the Electron desktop build, electron-main.js points
// these at a per-user, writable folder instead (Program Files isn't
// writable, and each person's WhatsApp session/queue must stay separate).
const DATA_DIR = process.env.DISPATCH_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AUTH_DIR = process.env.DISPATCH_AUTH_DIR || path.join(__dirname, '.wwebjs_auth');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------
// Reading/writing messages.json (same file format the original CLI tool
// used, so anyone migrating from it keeps their scheduled messages).
// ---------------------------------------------------------------------

function loadMessages() {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : [];
}

function saveMessages(messages) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(messages, null, 2));
}

function getNextOccurrence(currentDateIso, recurring) {
    const date = new Date(currentDateIso);
    if (recurring === 'daily') date.setDate(date.getDate() + 1);
    else if (recurring === 'weekly') date.setDate(date.getDate() + 7);
    return date.toISOString();
}

// ---------------------------------------------------------------------
// WhatsApp client. State (QR code, ready flag, account info) is kept in
// memory and exposed to the frontend through /api/status, which the
// dashboard polls every couple of seconds.
// ---------------------------------------------------------------------

let latestQrDataUrl = null;
let clientReady = false;
let accountInfo = null;
let lastError = null;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async (qr) => {
    latestQrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
    clientReady = false;
});

client.on('authenticated', () => {
    console.log('Authenticated. Session saved for next time.');
    lastError = null;
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
    lastError = `Authentication failed: ${msg}`;
});

client.on('ready', () => {
    clientReady = true;
    latestQrDataUrl = null;
    accountInfo = {
        name: client.info.pushname,
        number: client.info.wid.user
    };
    console.log(`WhatsApp client ready as ${accountInfo.name}.`);
});

client.on('disconnected', (reason) => {
    clientReady = false;
    accountInfo = null;
    lastError = `Disconnected: ${reason}`;
    console.error('WhatsApp disconnected:', reason);
});

client.initialize();

// ---------------------------------------------------------------------
// Core send logic - shared by the once-a-minute scheduler and the
// dashboard's "send now" button. Mirrors the original CLI tool's
// handling of groups, invite links, phone numbers, and images.
// ---------------------------------------------------------------------

async function resolveChatId(msg) {
    if (msg.to.endsWith('@g.us')) {
        return msg.to; // already a resolved group ID
    }

    if (msg.to.includes('chat.whatsapp.com/')) {
        const inviteCode = msg.to.split('chat.whatsapp.com/')[1].split(/[/?]/)[0];
        const inviteInfo = await client.getInviteInfo(inviteCode);
        const chatId = inviteInfo.id._serialized;
        msg.to = chatId; // cache resolved ID so we don't look it up again
        return chatId;
    }

    // Individual: ask WhatsApp to resolve the phone number into its
    // proper internal chat ID, rather than guessing "number@c.us".
    let chatId = `${msg.to}@c.us`; // fallback if lookup fails
    const numberDetails = await client.getNumberId(msg.to);
    if (numberDetails) chatId = numberDetails._serialized;
    return chatId;
}

async function sendScheduledMessage(msg) {
    const chatId = await resolveChatId(msg);

    if (msg.image) {
        let media;
        if (msg.image.startsWith('http://') || msg.image.startsWith('https://')) {
            media = await MessageMedia.fromUrl(msg.image, { unsafeMime: true });
        } else {
            const localPath = msg.image.startsWith('/uploads/')
                ? path.join(DATA_DIR, msg.image.replace('/uploads/', 'uploads/'))
                : msg.image;
            media = MessageMedia.fromFilePath(localPath);
        }
        await client.sendMessage(chatId, media, { caption: msg.message || '' });
    } else {
        await client.sendMessage(chatId, msg.message);
    }
}

// Runs every minute, same cadence as the original tool.
cron.schedule('* * * * *', async () => {
    if (!clientReady) return;

    const messages = loadMessages();
    const now = new Date();
    let changed = false;

    for (const msg of messages) {
        if (msg.sent) continue;
        if (new Date(msg.datetime) > now) continue;

        try {
            await sendScheduledMessage(msg);
            msg.lastError = null;

            if (msg.recurring) {
                msg.datetime = getNextOccurrence(msg.datetime, msg.recurring);
            } else {
                msg.sent = true;
            }
            changed = true;
        } catch (err) {
            console.error(`Failed to send to ${msg.to}:`, err.message);
            msg.lastError = err.message;
            changed = true;
            // Left un-sent so it's retried again next minute.
        }
    }

    if (changed) saveMessages(messages);
});

// ---------------------------------------------------------------------
// Web server + REST API
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({ dest: UPLOADS_DIR });

app.get('/api/status', (req, res) => {
    res.json({
        ready: clientReady,
        qr: latestQrDataUrl,
        account: accountInfo,
        lastError
    });
});

app.get('/api/messages', (req, res) => {
    const messages = loadMessages().sort(
        (a, b) => new Date(a.datetime) - new Date(b.datetime)
    );
    res.json(messages);
});

app.post('/api/messages', upload.single('imageFile'), (req, res) => {
    const { targetType, to, message, datetime, recurring, imageUrl } = req.body;

    if (targetType !== 'person' && targetType !== 'group') {
        return res.status(400).json({ error: 'targetType must be "person" or "group"' });
    }

    if (targetType === 'person' && !/^\d{7,15}$/.test(to || '')) {
        return res.status(400).json({ error: 'Phone number must be digits only, with country code (e.g. 94771234567)' });
    }

    if (targetType === 'group') {
        const isGroupId = (to || '').endsWith('@g.us');
        const isInviteLink = (to || '').includes('chat.whatsapp.com/');
        if (!isGroupId && !isInviteLink) {
            return res.status(400).json({ error: 'Group must be a real ID (ends in @g.us) or an invite link' });
        }
    }

    let imagePath = null;
    if (req.file) {
        imagePath = `/uploads/${req.file.filename}`;
    } else if (imageUrl) {
        imagePath = imageUrl;
    }

    if (!imagePath && !message) {
        return res.status(400).json({ error: 'Message text is required when there is no image' });
    }

    const scheduledDate = new Date(datetime);
    if (isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date/time' });
    }

    const validRecurring = ['none', 'daily', 'weekly'];
    const recurringValue = validRecurring.includes(recurring) ? recurring : 'none';

    if (scheduledDate.getTime() < Date.now() && recurringValue === 'none') {
        return res.status(400).json({ error: 'Pick a future date/time, or choose a repeating option' });
    }

    const messages = loadMessages();
    const newEntry = {
        id: Date.now().toString(),
        to,
        message: message || '',
        image: imagePath,
        datetime: scheduledDate.toISOString(),
        recurring: recurringValue === 'none' ? null : recurringValue,
        sent: false,
        lastError: null
    };

    messages.push(newEntry);
    saveMessages(messages);
    res.status(201).json(newEntry);
});

app.delete('/api/messages/:id', (req, res) => {
    const messages = loadMessages();
    const filtered = messages.filter((m) => m.id !== req.params.id);
    if (filtered.length === messages.length) {
        return res.status(404).json({ error: 'Message not found' });
    }
    saveMessages(filtered);
    res.json({ ok: true });
});

app.post('/api/messages/:id/send-now', async (req, res) => {
    if (!clientReady) {
        return res.status(409).json({ error: 'WhatsApp is not connected yet' });
    }

    const messages = loadMessages();
    const msg = messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    try {
        await sendScheduledMessage(msg);
        msg.lastError = null;
        if (msg.recurring) {
            msg.datetime = getNextOccurrence(new Date().toISOString(), msg.recurring);
        } else {
            msg.sent = true;
        }
        saveMessages(messages);
        res.json(msg);
    } catch (err) {
        msg.lastError = err.message;
        saveMessages(messages);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups', async (req, res) => {
    if (!clientReady) {
        return res.status(409).json({ error: 'WhatsApp is not connected yet' });
    }
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter((c) => c.isGroup)
            .map((g) => ({ name: g.name, id: g.id._serialized }));
        res.json(groups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`WhatsApp Scheduler dashboard running at http://localhost:${PORT}`);
});
