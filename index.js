require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const SYSTEM_PROMPT = require('./systemPrompt');
const express = require('express');

// ===== שרת QR =====
const app = express();
app.use(express.json());
let qrImageUrl = null;

app.get('/qr-status', (req, res) => {
  res.json({ qr: qrImageUrl, connected: !qrImageUrl });
});

app.get('/', (req, res) => {
  res.send(`<html>
  <head><title>ArtPrint Bot QR</title></head>
  <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif">
    <div style="text-align:center" id="content">
      <h2>ממתין ל-QR...</h2>
    </div>
    <script>
      async function checkQR() {
        const res = await fetch('/qr-status');
        const data = await res.json();
        const content = document.getElementById('content');
        if (data.connected) {
          content.innerHTML = '<h2 style="color:green">הבוט מחובר!</h2>';
        } else if (data.qr) {
          content.innerHTML = '<h2>סרוק עם וואטסאפ</h2><img src="' + data.qr + '" style="width:500px;height:500px"/><br/><br/><a href="/qr.png" download="qr.png" style="font-size:18px;padding:10px 20px;background:#25D366;color:#fff;text-decoration:none;border-radius:8px">הורד תמונה</a>';
        } else {
          content.innerHTML = '<h2>ממתין ל-QR...</h2>';
        }
      }
      checkQR();
      setInterval(checkQR, 5000);
    </script>
  </body></html>`);
});

app.get('/qr.png', async (req, res) => {
  if (!qrImageUrl) return res.status(404).send('No QR available');
  const base64Data = qrImageUrl.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename="qr.png"');
  res.send(imgBuffer);
});

// ===== Trading Reports Endpoint =====
app.post('/send-report', async (req, res) => {
  const { text, phone } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  const targetPhone = phone || process.env.OWNER_PHONE;
  if (!targetPhone) return res.status(400).json({ error: 'No phone configured' });
  try {
    const chatId = targetPhone.includes('@c.us') ? targetPhone : `${targetPhone}@c.us`;
    await client.sendMessage(chatId, text);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QR server running on port ${PORT}`));

// ===== הגדרות =====
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWNER_PHONE = process.env.OWNER_PHONE; // מספר בעל העסק לקבלת התראות
const MAX_HISTORY = 20; // מקסימום הודעות לשמור בהיסטוריה לכל לקוח

const conversations = new Map();
const pausedUsers = new Set();
const botCurrentlySending = new Set();
const lastMessageTime = new Map(); // מעקב אחרי זמן הודעה אחרונה לכל לקוח
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 דקות

const BOT_START_TIME = Math.floor(Date.now() / 1000);

// בדיקת שעות פעילות
function isOffHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hour = now.getHours();
  const day = now.getDay(); // 0=ראשון, 1=שני, 2=שלישי, 3=רביעי, 4=חמישי, 5=שישי, 6=שבת

  if (day === 6) return true; // שבת — סגור כל היום
  if (hour < 9) return true; // לפני 9:00 — כל הימים

  // שלישי ושישי: עובדים רק 9:00–13:00
  if ([2, 5].includes(day) && hour >= 13) return true;

  // א, ב, ד, ה: עובדים 9:00–13:00 ו-16:00–18:00
  if ([0, 1, 3, 4].includes(day) && hour >= 13 && hour < 16) return true; // הפסקה
  if ([0, 1, 3, 4].includes(day) && hour >= 18) return true; // אחרי 18:00

  return false;
}

// ===== חיבור WhatsApp =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', async (qr) => {
  console.log('New QR code generated - open the web URL to scan');
  qrcode.generate(qr, { small: true });
  qrImageUrl = await QRCode.toDataURL(qr, { width: 600, margin: 2 });
});

client.on('ready', () => {
  console.log('Bot is connected and ready!');
});

client.on('disconnected', (reason) => {
  console.log('Bot disconnected:', reason);
});


// ===== זיהוי תגובת בעלים — השהיית הבוט וסיכום שיחה =====
client.on('message_create', async (message) => {
  if (!message.fromMe) return;
  if (message.timestamp < BOT_START_TIME) return; // התעלם מהודעות ישנות
  if (message.to.endsWith('@g.us') || message.to === 'status@broadcast') return;
  if (message.to === `${OWNER_PHONE}@c.us`) return;
  if (botCurrentlySending.has(message.to)) return;
  if (!pausedUsers.has(message.to)) {
    pausedUsers.add(message.to);
    console.log(`Bot paused for [${message.to}] - owner replied`);
    await sendSummary(message.to, 'owner_reply');
  }
});

// ===== טיפול בהודעות נכנסות =====
client.on('message', async (message) => {
  if (message.from.endsWith('@g.us') || message.from === 'status@broadcast' || message.fromMe) return;
  if (message.timestamp < BOT_START_TIME) return;

  const userId = message.from;
  const userText = message.body?.trim();
  if (!userText) return;

  // ===== מצב יועץ פנימי — הבעלים שואל על מחירים =====
  const isOwner = userId === `${OWNER_PHONE}@c.us`;
  if (isOwner) {
    console.log(`Advisor query from owner: ${userText}`);
    try {
      const ownerHistory = conversations.get('owner') || [];
      ownerHistory.push({ role: 'user', content: userText });
      if (ownerHistory.length > MAX_HISTORY) ownerHistory.splice(0, ownerHistory.length - MAX_HISTORY);
      conversations.set('owner', ownerHistory);

      const advisorPrompt = SYSTEM_PROMPT + '\n\n=== מצב יועץ פנימי ===\nזוהי שאלה פנימית מצוות העסק. ענה ישירות ובתמציתיות על כל שאלת מחיר, מוצר, כמות, גודל או זמן אספקה — ללא שאלות אונבורדינג וללא ברכות פתיחה. פשוט תשובה עניינית.';
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: advisorPrompt,
        messages: ownerHistory
      });
      const reply = response.content[0].text;
      ownerHistory.push({ role: 'assistant', content: reply });
      await message.reply(reply);
    } catch (err) {
      console.error('Advisor error:', err.message);
    }
    return;
  }

  lastMessageTime.set(userId, Date.now());

  if (pausedUsers.has(userId)) {
    console.log(`Skipping [${userId}] - owner is handling`);
    return;
  }

  console.log(`Message from [${userId}]: ${userText}`);

  try {
    if (!conversations.has(userId)) {
      conversations.set(userId, []);
    }

    const history = conversations.get(userId);
    history.push({ role: 'user', content: userText });

    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    const isFirstMessage = history.length === 1;
    const offHoursNote = isOffHours()
      ? (isFirstMessage
        ? '\n\n=== הערה לבוט: עכשיו מחוץ לשעות הפעילות ===\nפתח את תשובתך בהודעה שאתה בוט אוטומטי ושהעסק כרגע סגור, אך אתה זמין לסייע בכל שאלה, מחיר או הזמנה. אחר כך המשך עם הברכה הרגילה.'
        : '\n\n=== הערה לבוט: עכשיו מחוץ לשעות הפעילות ===\nאם הלקוח מבקש שירות מיידי — הזכר שהעסק סגור כעת אך ניתן להשאיר פרטים.')
      : '';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + offHoursNote,
      messages: history
    });

    const botReply = response.content[0].text;
    history.push({ role: 'assistant', content: botReply });

    botCurrentlySending.add(userId);
    if (botReply.includes('[TRANSFER_TO_AGENT]')) {
      const cleanReply = botReply.replace('[TRANSFER_TO_AGENT]', '').trim();
      await message.reply(cleanReply);
      botCurrentlySending.delete(userId);
      await notifyOwner(userId, userText);
      await sendSummary(userId, 'transfer');
      console.log(`TRANSFER TO AGENT - [${userId}]`);
    } else {
      await message.reply(botReply);
      botCurrentlySending.delete(userId);
    }

    console.log(`Bot replied to [${userId}]: ${botReply.substring(0, 80)}...`);

  } catch (error) {
    console.error('ERROR:', error.message);
    await message.reply('מצטערים, אירעה תקלה זמנית. אנא נסה שוב או התקשר אלינו: 04-8438088');
  }
});

// ===== בדיקת חוסר פעילות כל 5 דקות =====
setInterval(async () => {
  const now = Date.now();
  for (const [userId, lastTime] of lastMessageTime.entries()) {
    if (now - lastTime > INACTIVITY_TIMEOUT && conversations.has(userId)) {
      console.log(`Inactivity timeout for [${userId}]`);
      await sendSummary(userId, 'inactivity');
      conversations.delete(userId);
      lastMessageTime.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ===== שליחת סיכום שיחה לבעלים =====
async function sendSummary(userId, reason) {
  if (!OWNER_PHONE || !conversations.has(userId)) return;
  const history = conversations.get(userId);
  if (history.length === 0) return;
  try {
    const reasonText = reason === 'transfer' ? 'העברה לנציג' : reason === 'owner_reply' ? 'בעלים ענה' : 'חוסר פעילות';
    const conversationText = history.map(m => `${m.role === 'user' ? 'לקוח' : 'בוט'}: ${m.content}`).join('\n');
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: 'סכם שיחה בעברית בקצרה: מי הלקוח, מה ביקש, מה הוצע לו, מה המצב. תשובה קצרה ועניינית.',
      messages: [{ role: 'user', content: conversationText }]
    });
    const summary = summaryResponse.content[0].text;
    const phone = userId.replace('@c.us', '');
    await client.sendMessage(`${OWNER_PHONE}@c.us`,
      `📋 *סיכום שיחה* (${reasonText})\n📱 מספר: ${phone}\n\n${summary}`
    );
  } catch (err) {
    console.error('Error sending summary:', err.message);
  }
}

// ===== שליחת התראה לבעל העסק =====
async function notifyOwner(userId, lastMessage) {
  if (!OWNER_PHONE) return;
  try {
    const notification = `New transfer to agent\nPhone: ${userId.replace('@c.us', '')}\nMessage: ${lastMessage}`;
    await client.sendMessage(`${OWNER_PHONE}@c.us`, notification);
  } catch (err) {
    console.error('Error notifying owner:', err.message);
  }
}

// ===== הפעלה =====
client.initialize();
