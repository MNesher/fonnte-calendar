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

  const pad = n => String(n).padStart(2, '0');
  return {
    action,
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth()+1)}-${pad(parsed.getDate())}`,
    time: `${pad(hour)}:${pad(minute)}`,
    address: extractAddress(message),
    description: message
  };
}

// ─── CREATE CALENDAR EVENT ────────────────────────────────────────────────────
async function createCalendarEvent(event, senderName, senderPhone) {
  const calendar = getCalendar();
  const [y,m,d] = event.date.split('-').map(Number);
  const [h,min] = event.time.split(':').map(Number);
  const start = new Date(y, m-1, d, h, min);
  const end   = new Date(start.getTime() + 30*60000); // 30 minutes
  const p = n => String(n).padStart(2,'0');
  const iso = dt => `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:00`;

  // Title: "Встреча — Имя (+972...)"
  const contactPart = senderName && senderName !== senderPhone
    ? `${senderName} (${senderPhone})`
    : senderPhone || senderName || '';
  const summary = contactPart ? `${event.action} — ${contactPart}` : event.action;

  // Description
  const lines = [
    `📱 WhatsApp: ${senderName || ''} ${senderPhone ? `(${senderPhone})` : ''}`.trim(),
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
    const created = await createCalendarEvent(event, name, phone);
    console.log(`   ✅ "${created.summary}" ${event.date} ${event.time}${event.address ? ' 📍'+event.address : ''}`);
    console.log(`   🔗 ${created.htmlLink}\n`);
  } catch(err) {
    console.error(`   ❌ ${err.message}\n`);
  }
});

app.get('/', (req, res) => res.send('✅ Fonnte→Calendar webhook is running'));

app.listen(PORT, () => console.log(`🚀 Port ${PORT} | Calendar: ${CALENDAR_ID}`));
