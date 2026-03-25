require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const SYSTEM_PROMPT = require('./systemPrompt');

// ===== הגדרות =====
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWNER_PHONE = process.env.OWNER_PHONE; // מספר בעל העסק לקבלת התראות
const MAX_HISTORY = 20; // מקסימום הודעות לשמור בהיסטוריה לכל לקוח

// שמירת היסטוריית שיחות לכל לקוח (מתאפס כשהבוט מתחיל מחדש)
const conversations = new Map();

// זמן הפעלת הבוט — מתעלמים מהודעות ישנות
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// ===== חיבור WhatsApp =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('\nScan the QR code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Bot is connected and ready!');
});

client.on('disconnected', (reason) => {
  console.log('Bot disconnected:', reason);
});

// ===== טיפול בהודעות נכנסות =====
client.on('message', async (message) => {
  // התעלם מהודעות קבוצה, סטטוס, ומהבוט עצמו
  if (message.from.endsWith('@g.us') || message.from === 'status@broadcast' || message.fromMe) return;

  // התעלם מהודעות ישנות שנשלחו לפני הפעלת הבוט
  if (message.timestamp < BOT_START_TIME) return;

  const userId = message.from;
  const userText = message.body?.trim();
  if (!userText) return;

  console.log(`Message from [${userId}]: ${userText}`);

  try {
    // אתחול היסטוריה אם לא קיימת
    if (!conversations.has(userId)) {
      conversations.set(userId, []);
    }

    const history = conversations.get(userId);

    // הוסף את הודעת הלקוח להיסטוריה
    history.push({ role: 'user', content: userText });

    // שמור רק את ה-MAX_HISTORY הודעות האחרונות
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    // שלח לקלוד
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history
    });

    const botReply = response.content[0].text;

    // הוסף את תשובת הבוט להיסטוריה
    history.push({ role: 'assistant', content: botReply });

    // בדוק אם צריך להעביר לנציג
    if (botReply.includes('[TRANSFER_TO_AGENT]')) {
      const cleanReply = botReply.replace('[TRANSFER_TO_AGENT]', '').trim();
      await message.reply(cleanReply);
      await notifyOwner(userId, userText);
      console.log(`TRANSFER TO AGENT - [${userId}]`);
    } else {
      await message.reply(botReply);
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
