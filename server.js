const express  = require('express');
const chrono   = require('chrono-node');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT        = process.env.PORT || 3000;
const CALENDAR_ID = process.env.CALENDAR_ID || 'Micha.nesher@gmail.com';

// ─── GOOGLE CALENDAR ──────────────────────────────────────────────────────────
let savedTokens = JSON.parse(process.env.GOOGLE_TOKENS);
const { client_id, client_secret } = JSON.parse(process.env.GOOGLE_CREDS);

function getCalendar() {
  const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3333/callback');
  auth.setCredentials(savedTokens);
  auth.on('tokens', (tokens) => {
    savedTokens = { ...savedTokens, ...tokens };
    console.log('🔄 Google tokens refreshed');
  });
  return google.calendar({ version: 'v3', auth });
}

// ─── KEYWORDS ─────────────────────────────────────────────────────────────────
const MEETING_KEYWORDS = [
  'встреч','совещан','звонок','созвон','зум','встрет',
  'напомни','сделать','задач','нужно','надо','запиши','не забу',
  'פגישה','שיחה','זום','ישיבה','תזכורת','לעשות','להזכיר','זכור',
  'meeting','call','appointment','zoom','remind','schedule','task','todo','don\'t forget'
];

const RU_MONTHS = {
  'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,
  'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12
};

function ruWeekdayOffset(text) {
  const days = {
    'понедельник':1,'вторник':2,'среду':3,'среда':3,'четверг':4,
    'пятницу':5,'пятница':5,'субботу':6,'суббота':6,'воскресенье':0
  };
  for (const [word, target] of Object.entries(days)) {
    if (text.includes(word)) {
      const today = new Date().getDay();
      let diff = target - today;
      if (diff <= 0) diff += 7;
      return diff;
    }
  }
  return null;
}

// ─── EXTRACT ADDRESS ──────────────────────────────────────────────────────────
function extractAddress(message) {
  // Hebrew/Russian address patterns: улица, street, רחוב, כתובת, по адресу, בכתובת
  const patterns = [
    /(?:по адресу|адрес)[:\s]+([^\n,]+)/i,
    /(?:улица|ул\.?)\s+([\w\s]+\d*)/i,
    /(?:בכתובת|רחוב)[:\s]+([^\n,]+)/i,
    /(?:at|@)\s+([A-Za-z0-9\s,]+(?:st|street|ave|avenue|rd|road|blvd|dr)\b[^\n]*)/i,
    /(?:address)[:\s]+([^\n,]+)/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

// ─── EXTRACT EVENT ─────────────────────────────────────────────────────────────
function extractEvent(message) {
  const lower = message.toLowerCase();
  if (!MEETING_KEYWORDS.some(k => lower.includes(k))) return null;

  const now = new Date();
  let refDate = null;

  if (lower.includes('послезавтра'))  refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  else if (lower.includes('завтра'))  refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  else if (lower.includes('сегодня')) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!refDate) {
    const offset = ruWeekdayOffset(lower);
    if (offset !== null) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  }

  if (!refDate) {
    const m = message.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
    if (m) {
      const day = parseInt(m[1]);
      const mon = RU_MONTHS[m[2].toLowerCase()];
      let year = now.getFullYear();
      if (mon < now.getMonth() + 1) year++;
      refDate = new Date(year, mon - 1, day);
    }
  }

  const chronoResults = chrono.parse(message, now, { forwardDate: true });
  let parsed = chronoResults.length > 0 ? chronoResults[0].start.date() : refDate;
  if (!parsed) return null;

  let hour = parsed.getHours(), minute = parsed.getMinutes();
  const timeMatch = message.match(/в\s+(\d{1,2})[:\.](\d{2})/);
  if (timeMatch) { hour = parseInt(timeMatch[1]); minute = parseInt(timeMatch[2]); }
  else {
    const hm = message.match(/в\s+(\d{1,2})\s*(час|утра|вечера|дня)?/);
    if (hm) { hour = parseInt(hm[1]); if (hm[2] === 'вечера' || hm[2] === 'дня') { if (hour < 12) hour += 12; } }
  }

  if (refDate && chronoResults.length === 0)
    parsed = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), hour, minute);

  // ── Title / action type
  let action = 'Событие';
  if (lower.includes('зум') || lower.includes('zoom'))                        action = 'Zoom';
  else if (lower.includes('звонок') || lower.includes('созвон') ||
           lower.includes('call'))                                             action = 'Звонок';
  else if (lower.includes('встреч') || lower.includes('meeting') ||
           lower.includes('appointment'))                                      action = 'Встреча';
  else if (lower.includes('совещан'))                                         action = 'Совещание';
  else if (lower.includes('сделать') || lower.includes('задач') ||
           lower.includes('нужно')   || lower.includes('надо')  ||
           lower.includes('task')    || lower.includes('todo'))                action = 'Задача';
  else if (lower.includes('напомни') || lower.includes('не забу') ||
           lower.includes('remind')  || lower.includes("don't forget"))       action = 'Напоминание';
  else if (lower.includes('פגישה'))  action = 'פגישה';
  else if (lower.includes('שיחה'))   action = 'שיחה';
  else if (lower.includes('לעשות') || lower.includes('להזכיר')) action = 'משימה';

  // ── Extract short subject (strip date/time noise words)
  let subject = message
    .replace(/\b(сегодня|завтра|послезавтра|сейчас)\b/gi, '')
    .replace(/\b(в\s+)?\d{1,2}[:.]\d{2}\b/g, '')
    .replace(/\b(в\s+)?\d{1,2}\s*(час|утра|вечера|дня)\b/gi, '')
    .replace(/\b(понедельник|вторник|среду?|четверг|пятниц[уа]|суббот[уа]|воскресенье)\b/gi, '')
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
    .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    .replace(/\b(at|on|in)\s+\d{1,2}(:\d{2})?(am|pm)?\b/gi, '')
    .replace(/\b\d{1,2}(:\d{2})?(am|pm)\b/gi, '')
    .replace(/\b(по адресу|адрес|address)[^,\n]*/gi, '')
    .replace(/[,.\s]{2,}/g, ' ')
    .trim()
    .slice(0, 60);

  const pad = n => String(n).padStart(2, '0');
  return {
    action,
    subject,
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth()+1)}-${pad(parsed.getDate())}`,
    time: `${pad(hour)}:${pad(minute)}`,
    address: extractAddress(message),
    description: message
  };
}

// ─── CREATE CALENDAR EVENT ────────────────────────────────────────────────────
async function createCalendarEvent(event, senderName, senderPhone, isManual) {
  const calendar = getCalendar();
  const [y,m,d] = event.date.split('-').map(Number);
  const [h,min] = event.time.split(':').map(Number);
  const start = new Date(y, m-1, d, h, min);
  const end   = new Date(start.getTime() + 30*60000); // 30 minutes
  const p = n => String(n).padStart(2,'0');
  const iso = dt => `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:00`;

  // Title logic:
  // Manual entry  → subject text from message (e.g. "сделать хешбониот")
  // WhatsApp      → "Встреча — Имя (+972...)"
  let summary;
  if (isManual) {
    summary = event.subject || event.action;
  } else {
    const contactPart = senderName && senderName !== senderPhone
      ? `${senderName} (${senderPhone})`
      : senderPhone || senderName || '';
    summary = contactPart ? `${event.action} — ${contactPart}` : event.subject || event.action;
  }

  // Description
  const lines = [
    !isManual && (senderName || senderPhone)
      ? `📱 WhatsApp: ${senderName || ''} ${senderPhone ? `(${senderPhone})` : ''}`.trim()
      : null,
    `🎯 Действие: ${event.action}`,
    event.address ? `📍 Адрес: ${event.address}` : null,
    ``,
    `💬 Сообщение:`,
    event.description,
  ].filter(l => l !== null);

  const requestBody = {
    summary,
    description: lines.join('\n'),
    start: { dateTime: iso(start), timeZone: 'Asia/Jerusalem' },
    end:   { dateTime: iso(end),   timeZone: 'Asia/Jerusalem' },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 90 },
        { method: 'popup', minutes: 15 },
      ]
    }
  };

  if (event.address) requestBody.location = event.address;

  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody });
  return res.data;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { message, sender, pushname } = req.body;
  if (!message) return;

  // sender is typically the phone number (e.g. "972501234567")
  const phone = sender ? `+${sender.replace(/^\+/, '')}` : '';
  const name  = pushname || '';
  const label = name ? `${name} ${phone}` : phone;
  console.log(`📨 ${label}: "${message.slice(0,80)}"`);

  const event = extractEvent(message);
  if (!event) { console.log('   ⏭️  No event\n'); return; }

  try {
    const created = await createCalendarEvent(event, name, phone, false);
    console.log(`   ✅ "${created.summary}" ${event.date} ${event.time}${event.address ? ' 📍'+event.address : ''}`);
    console.log(`   🔗 ${created.htmlLink}\n`);
  } catch(err) {
    console.error(`   ❌ ${err.message}\n`);
  }
});

app.get('/', (req, res) => res.send('✅ Fonnte→Calendar webhook is running'));

// ─── MANUAL ADD PAGE ───────────────────────────────────────────────────────────
const ADD_SECRET = process.env.ADD_SECRET || 'micha';

app.get('/add', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>📅 הוסף לקלנדר</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: white; border-radius: 20px; padding: 28px 24px;
          width: 100%; max-width: 440px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); }
  h1 { font-size: 1.4rem; margin-bottom: 6px; color: #111; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
  textarea { width: 100%; border: 2px solid #e0e0e0; border-radius: 12px;
             padding: 14px; font-size: 1rem; resize: none; height: 110px;
             transition: border 0.2s; font-family: inherit; direction: rtl; }
  textarea:focus { outline: none; border-color: #4CAF50; }
  .examples { color: #aaa; font-size: 0.78rem; margin: 8px 0 18px; line-height: 1.7; }
  .examples span { display: block; }
  button { width: 100%; background: #25D366; color: white; border: none;
           border-radius: 12px; padding: 15px; font-size: 1.05rem; font-weight: 600;
           cursor: pointer; transition: background 0.2s; }
  button:hover { background: #1ebe5d; }
  button:active { background: #17a050; transform: scale(0.98); }
  .result { margin-top: 18px; padding: 14px; border-radius: 12px; font-size: 0.9rem;
            text-align: center; display: none; }
  .result.ok  { background: #e8f5e9; color: #2e7d32; }
  .result.err { background: #fce4ec; color: #c62828; }
  .loader { display: none; text-align: center; margin-top: 14px; color: #888; }
</style>
</head>
<body>
<div class="card">
  <h1>📅 הוסף לקלנדר</h1>
  <p class="sub">כתוב בחופשיות — המערכת תזהה תאריך ושעה אוטומטית</p>
  <textarea id="msg" placeholder="לדוגמה: פגישה עם דוד מחר ב-14:00 ברחוב דיזנגוף 50&#10;или: встреча завтра в 11:00&#10;or: meeting tomorrow at 3pm"></textarea>
  <div class="examples">
    <span>✅ פגישה עם רועי ביום שלישי ב-10:00</span>
    <span>✅ встреча с клиентом в пятницу в 15:30</span>
    <span>✅ zoom call on Thursday at 2pm</span>
    <span>✅ сделать хешбониот сегодня в 10:00</span>
  </div>
  <button onclick="send()">➕ הוסף לקלנדר</button>
  <div class="loader" id="loader">⏳ מוסיף...</div>
  <div class="result" id="result"></div>
</div>
<script>
async function send() {
  const msg = document.getElementById('msg').value.trim();
  if (!msg) return;
  document.getElementById('loader').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  try {
    const r = await fetch('/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, secret: '${ADD_SECRET}' })
    });
    const data = await r.json();
    const el = document.getElementById('result');
    if (data.ok) {
      el.className = 'result ok';
      el.innerHTML = '✅ ' + data.summary + '<br><small>' + data.date + ' ' + data.time + (data.address ? '<br>📍 ' + data.address : '') + '</small>';
      document.getElementById('msg').value = '';
    } else {
      el.className = 'result err';
      el.innerHTML = '❌ ' + (data.error || 'לא זוהה תאריך/אירוע');
    }
    el.style.display = 'block';
  } catch(e) {
    const el = document.getElementById('result');
    el.className = 'result err';
    el.innerHTML = '❌ שגיאת חיבור';
    el.style.display = 'block';
  }
  document.getElementById('loader').style.display = 'none';
}
document.getElementById('msg').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
});
</script>
</body>
</html>`);
});

app.post('/add', async (req, res) => {
  const { message, secret } = req.body;
  if (secret !== ADD_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!message) return res.json({ ok: false, error: 'Empty message' });

  const event = extractEvent(message);
  if (!event) return res.json({ ok: false, error: 'No date/event found' });

  try {
    const created = await createCalendarEvent(event, '', '', true);
    console.log(`📝 Manual: "${created.summary}" ${event.date} ${event.time}`);
    res.json({ ok: true, summary: created.summary, date: event.date,
               time: event.time, address: event.address || null, link: created.htmlLink });
  } catch(err) {
    console.error(`❌ Manual add error: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Port ${PORT} | Calendar: ${CALENDAR_ID}`));
