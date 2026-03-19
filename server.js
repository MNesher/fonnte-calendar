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
  // Russian
  'встреч','совещан','звонок','созвон','зум','встрет',
  'напомни','сделать','задач','нужно','надо','запиши','не забу',
  // Hebrew — events / actions
  'פגישה','שיחה','זום','ישיבה','תזכורת','לעשות','להזכיר','זכור',
  'תור','נפגש','להיפגש','בישיבה','אירוע','ביקור','הצגה','טיסה',
  // Hebrew — date/time triggers (if someone writes time, it's likely a calendar item)
  'היום','מחר','מחרתיים','בשעה',
  // English
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
function extractEvent(message, skipKeywordCheck = false) {
  const lower = message.toLowerCase();
  if (!skipKeywordCheck && !MEETING_KEYWORDS.some(k => lower.includes(k))) return null;

  const now = new Date();
  let refDate = null;

  if (lower.includes('послезавтра'))  refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  else if (lower.includes('завтра'))  refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  else if (lower.includes('сегодня')) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (!refDate) {
    const offset = ruWeekdayOffset(lower);
    if (offset !== null) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  }

  // Hebrew date words
  if (!refDate) {
    if (lower.includes('מחרתיים')) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
    else if (lower.includes('מחר'))  refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    else if (lower.includes('היום')) refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

  // Russian time: "в 10:00", "в 10 вечера"
  const timeMatch = message.match(/в\s+(\d{1,2})[:\.](\d{2})/);
  if (timeMatch) { hour = parseInt(timeMatch[1]); minute = parseInt(timeMatch[2]); }
  else {
    const hm = message.match(/в\s+(\d{1,2})\s*(час|утра|вечера|дня)?/);
    if (hm) { hour = parseInt(hm[1]); if (hm[2] === 'вечера' || hm[2] === 'дня') { if (hour < 12) hour += 12; } }
  }

  // Hebrew time: "ב10", "ב-14:30", "בשעה 9"
  if (!timeMatch) {
    const heTime = message.match(/(?:בשעה\s+|ב-?)(\d{1,2})(?:[:.:](\d{2}))?(?!\d)/);
    if (heTime) {
      const h = parseInt(heTime[1]);
      if (h >= 6 && h <= 23) {
        hour   = h;
        minute = heTime[2] ? parseInt(heTime[2]) : 0;
      }
    }
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
  else if (lower.includes('פגישה') || lower.includes('להיפגש') || lower.includes('נפגש')) action = 'פגישה';
  else if (lower.includes('שיחה'))   action = 'שיחה';
  else if (lower.includes('זום'))    action = 'זום';
  else if (lower.includes('תור'))    action = 'תור';
  else if (lower.includes('טיסה'))   action = 'טיסה';
  else if (lower.includes('לעשות') || lower.includes('להזכיר')) action = 'משימה';

  // ── Extract short subject (strip date/time noise words)
  // Note: \b doesn't work with Cyrillic — use space-aware patterns instead
  let subject = message
    // Russian: "в пятницу", "в среду" etc (preposition + weekday together)
    .replace(/в\s+(?:понедельник|вторник|среду?|четверг|пятниц[уа]|суббот[уа]|воскресенье)/gi, ' ')
    // Russian: standalone weekday
    .replace(/(?:^|\s)(?:понедельник|вторник|среду?|четверг|пятниц[уа]|суббот[уа]|воскресенье)(?=\s|$)/gi, ' ')
    // Russian: сегодня/завтра/послезавтра
    .replace(/(?:^|\s)(?:сегодня|завтра|послезавтра|сейчас)(?=\s|$)/gi, ' ')
    // Russian: "в 10:00", "в 10", "в 10 вечера"
    .replace(/в\s+\d{1,2}(?:[:.]\d{2})?\s*(?:час|утра|вечера|дня)?/gi, ' ')
    // Any remaining time like "10:00"
    .replace(/\d{1,2}[:.]\d{2}/g, '')
    // English: "on Thursday", "on Monday"
    .replace(/\b(on|at)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi, ' ')
    // English weekdays standalone
    .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    // English: "at 2pm", "at 14:00"
    .replace(/\b(at|on)\s+\d{1,2}(:\d{2})?(am|pm)?\b/gi, '')
    .replace(/\b\d{1,2}(:\d{2})?(am|pm)\b/gi, '')
    // Hebrew: date words
    .replace(/(?:^|\s)(?:היום|מחר|מחרתיים)(?=\s|$)/g, ' ')
    // Hebrew: "ב10", "ב-14:30", "בשעה 9"
    .replace(/בשעה\s+\d{1,2}(?:[:.]\d{2})?/g, ' ')
    .replace(/ב-?\d{1,2}(?:[:.]\d{2})?/g, ' ')
    // Address chunks
    .replace(/(?:по адресу|адрес|address|בכתובת)[^,\n]*/gi, '')
    // Clean up
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

  // Duration and reminders by event type
  const isMeetingType = ['Встреча','Совещание','פגישה','תור','ישיבה'].includes(event.action);
  // Tasks/reminders/calls: 5 min duration, 1 reminder; Meetings: 60 min, 2 reminders
  const durationMin  = isMeetingType ? 60 : 5;
  const reminderMins = isMeetingType ? [90, 15] : [5];

  const end = new Date(start.getTime() + durationMin*60000);
  const p = n => String(n).padStart(2,'0');
  const iso = dt => `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:00`;

  // ── Deduplication: check if same event already exists within ±5 min window
  const windowStart = new Date(start.getTime() - 5*60000);
  const windowEnd   = new Date(start.getTime() + 5*60000);
  const existing = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: true,
  });
  const title = isManual ? (event.subject || event.action) : null; // compare by subject for manual
  const duplicate = (existing.data.items || []).find(e => {
    if (!e.summary) return false;
    const norm = s => s.toLowerCase().replace(/\s+/g,' ').trim();
    return norm(e.summary) === norm(event.subject || event.action) ||
           (title && norm(e.summary).includes(norm(title)));
  });
  if (duplicate) {
    console.log(`   ⏭️  Duplicate skipped: "${duplicate.summary}"`);
    return duplicate;
  }

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

  // Build description (event ID not known yet — will patch after insert)
  const BASE_URL = process.env.BASE_URL || 'https://fonnte-calendar-production.up.railway.app';

  const descLines = [
    !isManual && (senderName || senderPhone)
      ? `📱 WhatsApp: ${senderName || ''} ${senderPhone ? `(${senderPhone})` : ''}`.trim()
      : null,
    `🎯 Действие: ${event.action}`,
    event.address ? `📍 Адрес: ${event.address}` : null,
    ``,
    `💬 Сообщение:`,
    event.description,
    ``,
    `─────────────────`,
    `🔘 Статус: ожидает`,
  ].filter(l => l !== null);

  const requestBody = {
    summary,
    description: descLines.join('\n'),
    start: { dateTime: iso(start), timeZone: 'Asia/Jerusalem' },
    end:   { dateTime: iso(end),   timeZone: 'Asia/Jerusalem' },
    reminders: {
      useDefault: false,
      overrides: reminderMins.map(m => ({ method: 'popup', minutes: m }))
    }
  };

  if (event.address) requestBody.location = event.address;

  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody });
  const created = res.data;

  // Patch description to add manage link now that we have the event ID
  const manageUrl = `${BASE_URL}/event/${created.id}?t=${ADD_SECRET}`;
  const patchedDesc = descLines.join('\n') + `\n🔗 Управление: ${manageUrl}`;
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId: created.id,
    requestBody: { description: patchedDesc }
  });
  created.description = patchedDesc;
  return created;
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

// ─── EVENT STATUS PAGE ─────────────────────────────────────────────────────────
const STATUS_LABELS = {
  done:      { emoji: '✅', label: 'Сделано',       color: '2'  },  // green
  approved:  { emoji: '👍', label: 'Одобрено',      color: '2'  },  // green
  rejected:  { emoji: '❌', label: 'Не одобрено',   color: '11' },  // red
  undone:    { emoji: '🔴', label: 'Не сделано',    color: '11' },  // red
  pending:   { emoji: '🔘', label: 'Ожидает',       color: null },  // default
};

app.get('/event/:id', async (req, res) => {
  const { id } = req.params;
  const { t } = req.query;
  if (t !== ADD_SECRET) return res.status(403).send('Нет доступа');

  try {
    const calendar = getCalendar();
    const e = (await calendar.events.get({ calendarId: CALENDAR_ID, eventId: id })).data;
    const title = e.summary || '';
    const dt = e.start?.dateTime || '';
    const dateStr = dt ? new Date(dt).toLocaleString('ru-RU', { timeZone:'Asia/Jerusalem',
      weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';

    // Detect current status from title prefix
    let currentStatus = 'pending';
    for (const [key, v] of Object.entries(STATUS_LABELS)) {
      if (title.startsWith(v.emoji + ' ')) { currentStatus = key; break; }
    }
    const cleanTitle = title.replace(/^[✅👍❌🔴🔘]\s/, '');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Статус события</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,system-ui,sans-serif; background:#f0f2f5;
         min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .card { background:white; border-radius:20px; padding:28px 22px;
          width:100%; max-width:400px; box-shadow:0 4px 24px rgba(0,0,0,.10); }
  h2 { font-size:1.25rem; color:#111; margin-bottom:4px; line-height:1.3; }
  .dt { color:#888; font-size:.88rem; margin-bottom:22px; }
  .status-now { font-size:.9rem; color:#555; margin-bottom:18px; padding:10px 14px;
                background:#f5f5f5; border-radius:10px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .btn { border:none; border-radius:12px; padding:14px 8px; font-size:1rem;
         font-weight:600; cursor:pointer; transition:all .15s; }
  .btn:active { transform:scale(.96); }
  .btn-done     { background:#e8f5e9; color:#2e7d32; }
  .btn-approved { background:#e3f2fd; color:#1565c0; }
  .btn-undone   { background:#fce4ec; color:#c62828; }
  .btn-rejected { background:#fff3e0; color:#e65100; }
  .btn-pending  { background:#f3e5f5; color:#6a1b9a; grid-column:1/-1; }
  .btn.active   { outline:3px solid #333; }
  .result { margin-top:16px; padding:12px; border-radius:10px; text-align:center;
            font-size:.95rem; display:none; }
  .result.ok  { background:#e8f5e9; color:#2e7d32; }
  .result.err { background:#fce4ec; color:#c62828; }
</style>
</head>
<body>
<div class="card">
  <h2>${cleanTitle}</h2>
  <div class="dt">${dateStr}</div>
  <div class="status-now">Текущий статус: <strong>${STATUS_LABELS[currentStatus].emoji} ${STATUS_LABELS[currentStatus].label}</strong></div>
  <div class="grid">
    <button class="btn btn-done ${currentStatus==='done'?'active':''}"
      onclick="setStatus('done')">✅ Сделано</button>
    <button class="btn btn-approved ${currentStatus==='approved'?'active':''}"
      onclick="setStatus('approved')">👍 Одобрено</button>
    <button class="btn btn-undone ${currentStatus==='undone'?'active':''}"
      onclick="setStatus('undone')">🔴 Не сделано</button>
    <button class="btn btn-rejected ${currentStatus==='rejected'?'active':''}"
      onclick="setStatus('rejected')">❌ Не одобрено</button>
    <button class="btn btn-pending ${currentStatus==='pending'?'active':''}"
      onclick="setStatus('pending')">🔘 Сбросить статус</button>
  </div>
  <div class="result" id="result"></div>
</div>
<script>
async function setStatus(status) {
  try {
    const r = await fetch('/event/${id}/status', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ status, t: '${ADD_SECRET}' })
    });
    const data = await r.json();
    const el = document.getElementById('result');
    if (data.ok) {
      el.className = 'result ok';
      el.textContent = 'Сохранено: ' + data.label;
      el.style.display = 'block';
      document.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.btn-' + status)?.classList.add('active');
    } else {
      el.className = 'result err';
      el.textContent = 'Ошибка: ' + (data.error || '?');
      el.style.display = 'block';
    }
  } catch(e) {
    const el = document.getElementById('result');
    el.className = 'result err';
    el.textContent = 'Ошибка соединения';
    el.style.display = 'block';
  }
}
</script>
</body>
</html>`);
  } catch(err) {
    res.status(500).send('Ошибка: ' + err.message);
  }
});

app.post('/event/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, t } = req.body;
  if (t !== ADD_SECRET) return res.status(403).json({ error: 'Нет доступа' });
  if (!STATUS_LABELS[status]) return res.status(400).json({ error: 'Неверный статус' });

  try {
    const calendar = getCalendar();
    const e = (await calendar.events.get({ calendarId: CALENDAR_ID, eventId: id })).data;

    // Clean old status emoji from title
    const cleanTitle = (e.summary || '').replace(/^[✅👍❌🔴🔘]\s/, '');
    const { emoji, label, color } = STATUS_LABELS[status];
    const newTitle = status === 'pending' ? cleanTitle : `${emoji} ${cleanTitle}`;

    // Update status line in description
    const newDesc = (e.description || '')
      .replace(/🔘 Статус:.*/, `${emoji} Статус: ${label}`);

    const patch = {
      summary: newTitle,
      description: newDesc,
    };
    if (color) patch.colorId = color;
    else delete patch.colorId; // reset to default — use separate call

    await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: id, requestBody: patch });
    if (!color) {
      // Reset color by setting colorId to empty string not allowed — use update
      await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: id,
        requestBody: { colorId: '0' } });
    }

    console.log(`🏷️  Status "${label}" → "${newTitle}"`);
    res.json({ ok: true, label, emoji });
  } catch(err) {
    console.error('Status update error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─── MANUAL ADD PAGE ───────────────────────────────────────────────────────────
const ADD_SECRET = process.env.ADD_SECRET || 'micha';

app.get('/add', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ru" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>📅 В календарь</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: white; border-radius: 20px; padding: 28px 24px;
          width: 100%; max-width: 440px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); }
  h1 { font-size: 1.5rem; margin-bottom: 6px; color: #111; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
  textarea { width: 100%; border: 2px solid #e0e0e0; border-radius: 12px;
             padding: 14px; font-size: 1rem; resize: none; height: 120px;
             transition: border 0.2s; font-family: inherit; direction: ltr; text-align: left; }
  textarea:focus { outline: none; border-color: #4CAF50; }
  .examples { color: #bbb; font-size: 0.78rem; margin: 10px 0 20px; line-height: 1.8; }
  .examples span { display: block; }
  button { width: 100%; background: #4CAF50; color: white; border: none;
           border-radius: 12px; padding: 15px; font-size: 1.1rem; font-weight: 600;
           cursor: pointer; transition: background 0.2s; letter-spacing: 0.3px; }
  button:hover { background: #43a047; }
  button:active { background: #388e3c; transform: scale(0.98); }
  .result { margin-top: 16px; padding: 14px 16px; border-radius: 12px; font-size: 0.95rem;
            display: none; line-height: 1.5; }
  .result.ok      { background: #e8f5e9; color: #2e7d32; border-left: 4px solid #4CAF50; }
  .result.err     { background: #fce4ec; color: #c62828; border-left: 4px solid #e53935; }
  .result.warn    { background: #fff8e1; color: #5d4037; border-left: 4px solid #ffa000; }
  .result small   { display: block; margin-top: 4px; opacity: 0.75; font-size: 0.82rem; }
  .loader { display: none; text-align: center; margin-top: 14px; color: #999; font-size: 0.9rem; }
  .conflict-list  { margin: 8px 0 12px; padding-left: 16px; font-size: 0.9rem; }
  .conflict-list li { margin-bottom: 3px; }
  .conflict-btns  { display: flex; gap: 8px; margin-top: 10px; }
  .btn-confirm    { flex: 1; padding: 11px; border: none; border-radius: 10px;
                    background: #e65100; color: white; font-size: 0.95rem;
                    font-weight: 600; cursor: pointer; }
  .btn-cancel     { flex: 1; padding: 11px; border: none; border-radius: 10px;
                    background: #eee; color: #555; font-size: 0.95rem;
                    font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
  <h1>📅 В календарь</h1>
  <p class="sub">Пишите свободно — система автоматически найдёт дату и время</p>
  <textarea id="msg" placeholder="Примеры:&#10;встреча с Давидом завтра в 14:00&#10;сделать хешбониот сегодня в 10:00&#10;zoom с клиентом в пятницу в 15:30"></textarea>
  <div class="examples">
    <span>✅ встреча с Романом в среду в 11:00</span>
    <span>✅ сегодня в 10:00 подать документы Серябряникову</span>
    <span>✅ zoom call on Thursday at 2pm</span>
    <span>✅ פגישה עם דוד מחר ב-14:00</span>
  </div>
  <button onclick="send()">➕ Добавить в календарь</button>
  <div class="loader" id="loader">⏳ Добавляю...</div>
  <div class="result" id="result"></div>
</div>
<script>
let _pendingMsg = '';

async function send(force) {
  const msg = force ? _pendingMsg : document.getElementById('msg').value.trim();
  if (!msg) return;
  _pendingMsg = msg;
  document.getElementById('loader').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  try {
    const r = await fetch('/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, secret: '${ADD_SECRET}', force: !!force })
    });
    const data = await r.json();
    const el = document.getElementById('result');
    if (data.ok) {
      el.className = 'result ok';
      el.innerHTML = '✅ <strong>' + data.summary + '</strong>'
        + '<small>' + data.date + ' · ' + data.time + '–' + addMinutes(data.time, data.duration || 5)
        + (data.address ? ' · 📍 ' + data.address : '') + '</small>';
      document.getElementById('msg').value = '';
      _pendingMsg = '';
    } else if (data.conflict) {
      // Show conflict warning with confirm/cancel buttons
      el.className = 'result warn';
      let html = '⚠️ <strong>На это время уже есть:</strong><ul class="conflict-list">';
      data.conflicts.forEach(c => {
        html += '<li>' + c.start + '–' + c.end + ' · ' + escHtml(c.summary) + '</li>';
      });
      html += '</ul>Создать событие всё равно?';
      html += '<div class="conflict-btns">'
            + '<button class="btn-confirm" onclick="send(true)">✅ Да, создать</button>'
            + '<button class="btn-cancel"  onclick="cancelConflict()">✖ Отмена</button>'
            + '</div>';
      el.innerHTML = html;
    } else {
      el.className = 'result err';
      el.innerHTML = '❌ ' + (data.error || 'Не найдена дата или время');
    }
    el.style.display = 'block';
  } catch(e) {
    const el = document.getElementById('result');
    el.className = 'result err';
    el.innerHTML = '❌ Ошибка соединения';
    el.style.display = 'block';
  }
  document.getElementById('loader').style.display = 'none';
}
function cancelConflict() {
  _pendingMsg = '';
  const el = document.getElementById('result');
  el.style.display = 'none';
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function addMinutes(time, mins) {
  const [h,m] = time.split(':').map(Number);
  const t = h*60+m+mins;
  return String(Math.floor(t/60)%24).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
}
document.getElementById('msg').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(false);
});
</script>
</body>
</html>`);
});

app.post('/add', async (req, res) => {
  const { message, secret, force } = req.body;
  if (secret !== ADD_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!message) return res.json({ ok: false, error: 'Empty message' });

  const event = extractEvent(message, true); // manual: skip keyword check
  if (!event) return res.json({ ok: false, error: 'Не найдена дата или время' });

  const isMeetingType = ['Встреча','Совещание','פגישה','תור','ישיבה'].includes(event.action);
  const durationMin = isMeetingType ? 60 : 5;

  // ── Conflict check (skip if force=true)
  if (!force) {
    try {
      const calendar = getCalendar();
      const [y,m,d] = event.date.split('-').map(Number);
      const [h,min] = event.time.split(':').map(Number);
      const start = new Date(y, m-1, d, h, min);
      const end   = new Date(start.getTime() + durationMin * 60000);

      const existing = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      const conflicts = (existing.data.items || []).filter(e => e.status !== 'cancelled');
      if (conflicts.length > 0) {
        const fmt = dt => dt ? new Date(dt).toLocaleTimeString('ru-RU',
          { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jerusalem' }) : '';
        return res.json({
          ok: false,
          conflict: true,
          conflicts: conflicts.map(e => ({
            summary: e.summary || '(без названия)',
            start:   fmt(e.start?.dateTime || e.start?.date),
            end:     fmt(e.end?.dateTime   || e.end?.date),
          })),
          parsed: { date: event.date, time: event.time, duration: durationMin },
        });
      }
    } catch(err) {
      console.warn('Conflict check failed:', err.message);
      // don't block creation if check fails
    }
  }

  try {
    const created = await createCalendarEvent(event, '', '', true);
    console.log(`📝 Manual: "${created.summary}" ${event.date} ${event.time}`);
    res.json({ ok: true, summary: created.summary, date: event.date,
               time: event.time, duration: durationMin,
               address: event.address || null, link: created.htmlLink });
  } catch(err) {
    console.error(`❌ Manual add error: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Port ${PORT} | Calendar: ${CALENDAR_ID}`));
