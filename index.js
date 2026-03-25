require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const SYSTEM_PROMPT = require('./systemPrompt');
const express = require('express');

// ===== שרת QR =====
const app = express();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QR server running on port ${PORT}`));

// ===== הגדרות =====
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWNER_PHONE = process.env.OWNER_PHONE; // מספר בעל העסק לקבלת התראות
const MAX_HISTORY = 20; // מקסימום הודעות לשמור בהיסטוריה לכל לקוח

// שמירת היסטוריית שיחות לכל לקוח (מתאפס כשהבוט מתחיל מחדש)
const conversations = new Map();

// לקוחות שהבעלים ענה להם ישירות — הבוט לא יענה להם
const pausedUsers = new Set();
const botMessageIds = new Set(); // IDs של הודעות שהבוט שלח

// זמן הפעלת הבוט — מתעלמים מהודעות ישנות
const BOT_START_TIME = Math.floor(Date.now() / 1000);

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


// ===== זיהוי תגובת בעלים — השהיית הבוט ללקוח זה =====
client.on('message_create', (message) => {
  if (!message.fromMe) return;
  if (message.to.endsWith('@g.us') || message.to === 'status@broadcast') return;
  if (botMessageIds.has(message.id?.id)) {
    botMessageIds.delete(message.id?.id); // הודעה של הבוט — מתעלמים
    return;
  }
  pausedUsers.add(message.to); // הודעה של הבעלים — עוצרים את הבוט
  console.log(`Bot paused for user [${message.to}] - owner replied`);
});

// ===== טיפול בהודעות נכנסות =====
client.on('message', async (message) => {
  if (message.from.endsWith('@g.us') || message.from === 'status@broadcast' || message.fromMe) return;
  if (message.timestamp < BOT_START_TIME) return;

  const userId = message.from;
  const userText = message.body?.trim();
  if (!userText) return;

  // אם הבעלים ענה ללקוח הזה — הבוט לא מתערב
  if (pausedUsers.has(userId)) {
    console.log(`Skipping [${userId}] - owner is handling this conversation`);
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

    console.log('Calling Claude API...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history
    });

    console.log('Claude API responded!');
    const botReply = response.content[0].text;

    history.push({ role: 'assistant', content: botReply });

    // בדוק אם צריך להעביר לנציג
    if (botReply.includes('[TRANSFER_TO_AGENT]')) {
      const cleanReply = botReply.replace('[TRANSFER_TO_AGENT]', '').trim();
      const sent = await message.reply(cleanReply);
      if (sent?.id?.id) botMessageIds.add(sent.id.id);
      await notifyOwner(userId, userText);
      console.log(`TRANSFER TO AGENT - [${userId}]`);
    } else {
      const sent = await message.reply(botReply);
      if (sent?.id?.id) botMessageIds.add(sent.id.id);
    }

    console.log(`Bot replied to [${userId}]: ${botReply.substring(0, 80)}...`);

  } catch (error) {
    console.error('ERROR:', error.message);
    await message.reply('מצטערים, אירעה תקלה זמנית. אנא נסה שוב או התקשר אלינו: 04-8438088');
  }
});

// ===== שליחת התראה לבעל העסק =====
async function notifyOwner(userId, lastMessage) {
  if (!OWNER_PHONE) return;
  try {
    const notification = `New transfer to agent\nPhone: ${userId.replace('@c.us', '')}\nMessage: ${lastMessage}`;
    await client.sendMessage(`${OWNER_PHONE}@c.us`, notification);
  } catch (err) {
    console.error('שגיאה בשליחת התראה לבעלים:', err.message);
  }
}

// ===== הפעלה =====
client.initialize();
