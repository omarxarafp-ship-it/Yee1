import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import gplay from 'google-play-scraper';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;
import axios from 'axios';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    console.log('📁 تم إنشاء مجلد التحميلات');
}

function cleanupOldDownloads() {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const now = Date.now();
        const maxAge = 30 * 60 * 1000;
        
        for (const file of files) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ تم حذف ملف قديم: ${file}`);
            }
        }
    } catch (error) {
        console.error('خطأ في تنظيف الملفات القديمة:', error.message);
    }
}

setInterval(cleanupOldDownloads, 10 * 60 * 1000);

const logger = pino({ level: 'silent' });

const DEVELOPER_PHONES = ['212718938088', '234905250308102'];
const BOT_PROFILE_IMAGE_URL = 'https://i.postimg.cc/TPgStdfc/Screenshot-2025-11-25-08-24-05-916-com-openai-chatgpt-edit.jpg';
const INSTAGRAM_URL = 'https://www.instagram.com/said91447';
const POWERED_BY = '\n\n_Powered by AppOmar_';
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

const ZARCHIVER_PACKAGE = 'ru.zdevs.zarchiver';
function getZArchiverTutorial(fileName) {
    return `📦 *طريقة تثبيت ملف XAPK*

━━━━━━━━━━━━━━━━━━━━━

1️⃣ افتح الملف بواسطة ZArchiver
2️⃣ ارجع للخلف بعد فتح الملف
3️⃣ ستجد الملف باسم:
   📁 *${fileName}*
4️⃣ اضغط على الملف
5️⃣ اختر "تثبيت" أو "Install"

━━━━━━━━━━━━━━━━━━━━━

💡 *ملاحظة:* تأكد من تفعيل خيار "مصادر غير معروفة" في إعدادات هاتفك

📥 لتحميل ZArchiver أرسل: zarchiver`;
}

const ZARCHIVER_TUTORIAL_BASIC = `📦 *طريقة تثبيت ملف XAPK*

← افتح الملف بواسطة ZArchiver
← ارجع للخلف بعد فتح الملف
← ستجد الملف باسمه
← اضغط على الملف
← اختر "تثبيت" أو "Install"

📥 لتحميل ZArchiver أرسل: zarchiver`;

let pool = null;
let dbEnabled = false;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
    });
}

const userSessions = new Map();
const requestQueue = new Map();
const blockedNumbers = new Set();
const vipUsers = new Set();
const hourlyMessageTracker = new Map();
const downloadMessageTracker = new Map();
const groupMetadataCache = new Map();
const messageStore = new Map();
const lidToPhoneMap = new Map();
const VIP_PASSWORD = 'Omar';

let pairingCodeRequested = false;
let globalSock = null;
let botImageBuffer = null;

function getRandomDelay(min = 200, max = 800) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getTypingDuration(textLength) {
    return Math.random() > 0.5 ? 1000 : 1500;
}

async function getCachedGroupMetadata(sock, jid) {
    if (groupMetadataCache.has(jid)) {
        const cached = groupMetadataCache.get(jid);
        if (Date.now() - cached.timestamp < 300000) {
            return cached.data;
        }
    }
    try {
        const metadata = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data: metadata, timestamp: Date.now() });
        return metadata;
    } catch (error) {
        console.error('خطأ في جلب بيانات المجموعة:', error.message);
        return null;
    }
}

function storeMessage(key, message) {
    if (!key || !key.id) return;
    const storeKey = `${key.remoteJid}_${key.id}`;
    messageStore.set(storeKey, message);
    if (messageStore.size > 1000) {
        const keysToDelete = Array.from(messageStore.keys()).slice(0, 200);
        keysToDelete.forEach(k => messageStore.delete(k));
    }
}

function getStoredMessage(key) {
    if (!key || !key.id) return { conversation: '' };
    const storeKey = `${key.remoteJid}_${key.id}`;
    return messageStore.get(storeKey) || { conversation: '' };
}

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️  DATABASE_URL غير موجود - البوت يعمل بدون قاعدة بيانات');
        dbEnabled = false;
        return;
    }
    try {
        console.log('🗄️  جاري التحقق من قاعدة البيانات...');
        const client = await pool.connect();
        const schemaPath = path.join(__dirname, 'database', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await client.query(schema);
            console.log('✅ تم التأكد من وجود جداول قاعدة البيانات');
        }
        await client.query('SELECT 1');
        client.release();
        dbEnabled = true;
        console.log('✅ قاعدة البيانات متصلة بنجاح!');
    } catch (error) {
        dbEnabled = false;
        console.error('❌ خطأ في الاتصال بقاعدة البيانات:', error.message);
        console.log('⚠️  البوت يعمل بدون قاعدة بيانات');
    }
}

async function simulateTyping(sock, remoteJid, textLength = 50) {
    try {
        await sock.presenceSubscribe(remoteJid);
        await new Promise(r => setTimeout(r, getRandomDelay(300, 800)));
        await sock.sendPresenceUpdate('composing', remoteJid);
        const typingDuration = getTypingDuration(textLength);
        await new Promise(r => setTimeout(r, typingDuration));
        await sock.sendPresenceUpdate('paused', remoteJid);
        await new Promise(r => setTimeout(r, getRandomDelay(200, 500)));
    } catch (error) {
        console.log('⚠️ خطأ في إظهار الكتابة:', error.message);
    }
}

async function sendBotMessage(sock, remoteJid, content, originalMsg = null) {
    const textLength = content.text?.length || content.caption?.length || 50;
    await simulateTyping(sock, remoteJid, textLength);
    await new Promise(r => setTimeout(r, getRandomDelay(500, 1500)));
    const messageContent = { ...content };
    if (originalMsg && originalMsg.key) {
        messageContent.quoted = originalMsg;
    }
    const sentMsg = await sock.sendMessage(remoteJid, messageContent);
    if (sentMsg && sentMsg.key) {
        storeMessage(sentMsg.key, sentMsg.message);
    }
    return sentMsg;
}

async function downloadBotProfileImage() {
    try {
        if (botImageBuffer) return botImageBuffer;
        const imagePath = path.join(__dirname, 'bot_assets', 'profile.jpg');
        if (fs.existsSync(imagePath)) {
            botImageBuffer = fs.readFileSync(imagePath);
            return botImageBuffer;
        }
        console.log('📥 جاري تحميل صورة البروفايل...');
        const response = await axios.get(BOT_PROFILE_IMAGE_URL, { responseType: 'arraybuffer', timeout: 15000 });
        botImageBuffer = Buffer.from(response.data);
        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        fs.writeFileSync(imagePath, botImageBuffer);
        return botImageBuffer;
    } catch (error) {
        console.error('❌ خطأ في تحميل صورة البوت:', error.message);
        return null;
    }
}

async function setBotProfile(sock) {
    try {
        const imageBuffer = await downloadBotProfileImage();
        if (imageBuffer) {
            await sock.updateProfilePicture(sock.user.id, imageBuffer);
            console.log('✅ تم تحديث صورة البروفايل');
        }
    } catch (error) {
        console.error('⚠️  خطأ في تحديث صورة البروفايل:', error.message);
    }
}

function decodeJid(jid) {
    if (!jid) return null;
    try {
        const decoded = jidDecode(jid);
        return decoded;
    } catch (error) {
        return null;
    }
}

function isLidFormat(jid) {
    if (!jid) return false;
    return jid.endsWith('@lid') || jid.includes('@lid');
}

function getSenderPhone(remoteJid, participant, altJid = null) {
    let jid = remoteJid;
    if (remoteJid.endsWith('@g.us') && participant) {
        jid = participant;
    }

    const decoded = decodeJid(jid);
    if (!decoded) {
        return jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
    }

    if (decoded.server === 'lid') {
        if (altJid) {
            const altDecoded = decodeJid(altJid);
            if (altDecoded && altDecoded.server === 's.whatsapp.net') {
                lidToPhoneMap.set(jid, altDecoded.user);
                return altDecoded.user;
            }
        }
        if (lidToPhoneMap.has(jid)) {
            return lidToPhoneMap.get(jid);
        }
        return decoded.user;
    }

    return decoded.user || jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
}

function isValidPhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15 && /^\d+$/.test(cleaned);
}

function getUserId(remoteJid, participant) {
    if (remoteJid.endsWith('@g.us') && participant) {
        return participant;
    }
    return remoteJid;
}

function extractPhoneFromMessage(msg) {
    const remoteJid = msg.key?.remoteJid;
    const participant = msg.key?.participant;
    const remoteJidAlt = msg.key?.remoteJidAlt;
    const participantAlt = msg.key?.participantAlt;

    let altJid = null;
    if (remoteJid?.endsWith('@g.us') && participantAlt) {
        altJid = participantAlt;
    } else if (remoteJidAlt) {
        altJid = remoteJidAlt;
    }

    return getSenderPhone(remoteJid, participant, altJid);
}

function isDeveloper(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    return DEVELOPER_PHONES.some(devPhone => cleanPhone === devPhone || cleanPhone.endsWith(devPhone));
}

async function checkBlacklist(phone) {
    if (blockedNumbers.has(phone)) return true;
    if (!dbEnabled) return false;
    try {
        const result = await pool.query('SELECT * FROM blacklist WHERE phone_number = $1', [phone]);
        if (result.rows.length > 0) {
            blockedNumbers.add(phone);
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function blockUser(phone, reason) {
    blockedNumbers.add(phone);
    console.log(`🚫 تم حظر: ${phone} - السبب: ${reason}`);
    if (!dbEnabled) return;
    try {
        await pool.query('INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING', [phone, reason]);
    } catch (error) {
        console.error('خطأ في حظر الرقم:', error);
    }
}

async function unblockUser(phone) {
    blockedNumbers.delete(phone);
    console.log(`✅ تم إلغاء حظر: ${phone}`);
    if (!dbEnabled) return true;
    try {
        await pool.query('DELETE FROM blacklist WHERE phone_number = $1', [phone]);
        return true;
    } catch (error) {
        return false;
    }
}

async function updateUserActivity(phone, userName) {
    if (!dbEnabled) return;
    if (!isValidPhoneNumber(phone)) {
        console.log(`⚠️  تخطي حفظ رقم غير صالح: ${phone}`);
        return;
    }
    try {
        await pool.query(
            'INSERT INTO users (phone_number, username, last_activity) VALUES ($1, $2, NOW()) ON CONFLICT (phone_number) DO UPDATE SET last_activity = NOW(), username = $2',
            [phone, userName]
        );
    } catch (error) {}
}

function checkHourlySpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let tracker = hourlyMessageTracker.get(phone);
    if (!tracker) {
        tracker = { messages: [] };
        hourlyMessageTracker.set(phone, tracker);
    }
    tracker.messages = tracker.messages.filter(t => now - t < oneHour);
    tracker.messages.push(now);
    if (tracker.messages.length > 25) {
        return 'block';
    }
    return 'ok';
}

function checkDownloadSpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    if (vipUsers.has(phone)) return 'ok';
    let tracker = downloadMessageTracker.get(phone);
    if (!tracker) return 'ok';
    if (tracker.count >= 5) {
        return 'block';
    }
    tracker.count++;
    downloadMessageTracker.set(phone, tracker);
    return 'ok';
}

function startDownloadTracking(phone) {
    downloadMessageTracker.set(phone, { count: 0 });
}

function stopDownloadTracking(phone) {
    downloadMessageTracker.delete(phone);
}

async function logDownload(userPhone, appId, appName, fileType, fileSize) {
    if (!dbEnabled) return;
    if (!isValidPhoneNumber(userPhone)) return;
    try {
        await pool.query(
            'INSERT INTO downloads (user_phone, app_id, app_name, file_type, file_size) VALUES ($1, $2, $3, $4, $5)',
            [userPhone, appId, appName, fileType, fileSize]
        );
        await pool.query('UPDATE users SET total_downloads = total_downloads + 1 WHERE phone_number = $1', [userPhone]);
    } catch (error) {}
}

async function getStats() {
    if (!dbEnabled) return null;
    try {
        const usersResult = await pool.query('SELECT COUNT(*) as total FROM users');
        const downloadsResult = await pool.query('SELECT COUNT(*) as total, SUM(file_size) as total_size FROM downloads');
        const todayDownloads = await pool.query("SELECT COUNT(*) as total FROM downloads WHERE created_at >= CURRENT_DATE");
        const topApps = await pool.query('SELECT app_name, COUNT(*) as count FROM downloads GROUP BY app_name ORDER BY count DESC LIMIT 5');
        const blockedResult = await pool.query('SELECT COUNT(*) as total FROM blacklist');
        return {
            totalUsers: usersResult.rows[0].total,
            totalDownloads: downloadsResult.rows[0].total,
            totalSize: downloadsResult.rows[0].total_size || 0,
            todayDownloads: todayDownloads.rows[0].total,
            topApps: topApps.rows,
            blockedUsers: blockedResult.rows[0].total
        };
    } catch (error) {
        return null;
    }
}

async function broadcastMessage(sock, message) {
    if (!dbEnabled) return { success: 0, failed: 0 };
    try {
        const users = await pool.query('SELECT phone_number FROM users');
        let success = 0, failed = 0;
        for (const user of users.rows) {
            try {
                if (!isValidPhoneNumber(user.phone_number)) {
                    failed++;
                    continue;
                }
                const jid = `${user.phone_number}@s.whatsapp.net`;
                await simulateTyping(sock, jid, message.length);
                await sock.sendMessage(jid, { text: `📢 *رسالة من المطور*\n\n${message}${POWERED_BY}` });
                success++;
                await new Promise(r => setTimeout(r, getRandomDelay(5000, 10000)));
            } catch { failed++; }
        }
        return { success, failed };
    } catch (error) {
        return { success: 0, failed: 0 };
    }
}

async function getUserHistory(phone) {
    if (!dbEnabled) return [];
    try {
        const result = await pool.query('SELECT app_name, file_type, created_at FROM downloads WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 10', [phone]);
        return result.rows;
    } catch (error) {
        return [];
    }
}

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} bytes`;
}

function formatAppInfo(appDetails, fileType, fileSize) {
    return `📱 *${appDetails.title}*

→ النوع: ${fileType.toUpperCase()}
→ الحجم: ${formatFileSize(fileSize)}
→ التحميلات: ${appDetails.installs || 'غير معروف'}`;
}

function formatSearchResults(results) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let text = `🔍 *نتائج البحث*\n\n`;
    
    results.forEach((app, index) => {
        const emoji = numberEmojis[index] || `${index + 1}→`;
        text += `${emoji} → ${app.title}\n`;
    });
    
    text += `\n📝 أرسل رقم التطبيق (1-${results.length})`;
    
    return text;
}

async function downloadAPKWithAxios(packageName, appTitle) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';
    
    console.log(`📥 جاري التحميل عبر Axios (Streaming)...`);
    
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`   محاولة ${attempt + 1}/3...`);
            
            const response = await axios({
                method: 'GET',
                url: `${API_URL}/download/${packageName}`,
                responseType: 'stream',
                timeout: 600000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            
            const fileType = response.headers['x-file-type'] || 'apk';
            const source = response.headers['x-source'] || 'apkpure';
            const contentLength = parseInt(response.headers['content-length'] || '0');
            
            const chunks = [];
            let downloadedBytes = 0;
            const startTime = Date.now();
            
            await new Promise((resolve, reject) => {
                response.data.on('data', (chunk) => {
                    chunks.push(chunk);
                    downloadedBytes += chunk.length;
                    if (contentLength > 0) {
                        const progress = ((downloadedBytes / contentLength) * 100).toFixed(0);
                        process.stdout.write(`\r   ⬇️  ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(contentLength / 1024 / 1024).toFixed(1)}MB (${progress}%)`);
                    } else {
                        process.stdout.write(`\r   ⬇️  ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB تم تحميله...`);
                    }
                });
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });
            
            const buffer = Buffer.concat(chunks);
            const fileSize = buffer.length;
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const speed = (fileSize / 1024 / 1024 / parseFloat(elapsedTime)).toFixed(2);
            
            const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
            const filename = `${safeTitle}.${fileType}`;
            
            console.log(`\n✅ تم التحميل من ${source}: ${formatFileSize(fileSize)} | السرعة: ${speed} MB/s`);
            
            if (buffer.length > 100000) {
                return { buffer, filename, size: fileSize, fileType };
            }
            
            throw new Error('الملف المحمل صغير جداً');
            
        } catch (error) {
            console.log(`\n   ❌ المحاولة ${attempt + 1} فشلت: ${error.message}`);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    console.log(`📥 استخدام الطريقة البديلة (cloudscraper)...`);
    return await downloadAPKStreamFallback(packageName, appTitle);
}

async function downloadAPKStreamFallback(packageName, appTitle) {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, 'scrap.py');
        const pythonProcess = spawn('python3', [pythonScript, packageName]);
        let output = '', error = '';
        pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { error += data.toString(); });
        pythonProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const filePath = output.trim();
                if (fs.existsSync(filePath)) {
                    const buffer = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    const fileSize = fs.statSync(filePath).size;
                    fs.unlinkSync(filePath);
                    const fileType = filename.toLowerCase().endsWith('.xapk') ? 'xapk' : 'apk';
                    const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
                    resolve({ buffer, filename: `${safeTitle}.${fileType}`, size: fileSize, fileType });
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
        pythonProcess.on('error', () => resolve(null));
    });
}

async function processRequest(sock, from, task) {
    let queue = requestQueue.get(from);
    if (!queue) {
        queue = { processing: false, tasks: [] };
        requestQueue.set(from, queue);
    }
    queue.tasks.push(task);
    if (queue.processing) return;
    queue.processing = true;
    while (queue.tasks.length > 0) {
        const currentTask = queue.tasks.shift();
        try { await currentTask(); } catch (error) { console.error('خطأ في معالجة الطلب:', error); }
    }
    queue.processing = false;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        cachedGroupMetadata: async (jid) => {
            const cached = groupMetadataCache.get(jid);
            if (cached && Date.now() - cached.timestamp < 300000) {
                return cached.data;
            }
            return null;
        },
        getMessage: async (key) => {
            return getStoredMessage(key);
        }
    });

    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (msg.key && msg.message) {
                storeMessage(msg.key, msg.message);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('❌ الاتصال مغلق');
            if (shouldReconnect) {
                pairingCodeRequested = false;
                const reconnectDelay = getRandomDelay(6000, 15000);
                console.log(`⏳ إعادة الاتصال خلال ${Math.round(reconnectDelay/1000)} ثواني...`);
                setTimeout(() => connectToWhatsApp(), reconnectDelay);
            }
        } else if (connection === 'open') {
            console.log('✅ متصل بواتساب بنجاح!');
            console.log('🤖 بوت AppOmar جاهز للاستخدام');
            console.log(`👨‍💻 رقم المطور: ${DEVELOPER_PHONES.join(', ')}`);
            pairingCodeRequested = false;
            try { await sock.sendPresenceUpdate('unavailable'); } catch {}
            await new Promise(r => setTimeout(r, getRandomDelay(2000, 5000)));
            await setBotProfile(sock);
        } else if (connection === 'connecting') {
            console.log('🔗 جاري الاتصال بواتساب...');
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                const phoneNumber = process.env.PHONE_NUMBER;
                if (!phoneNumber) {
                    console.error('\n❌ خطأ: متغير البيئة PHONE_NUMBER غير موجود!');
                    process.exit(1);
                }
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log('\n📱 رمز الاقتران الخاص بك:');
                        console.log(`        ${code}        \n`);
                    } catch (error) {
                        console.error('❌ خطأ في طلب رمز الاقتران:', error.message);
                        pairingCodeRequested = false;
                    }
                }, 3000);
            }
        }
    });

    sock.ev.on('call', async (callData) => {
        for (const call of callData) {
            if (call.status === 'offer') {
                const callerPhone = getSenderPhone(call.from, null);
                if (isDeveloper(callerPhone)) {
                    console.log(`📞 مكالمة من المطور - لن يتم الحظر`);
                    return;
                }
                console.log(`📞 مكالمة واردة من: ${callerPhone} - جاري الحظر`);
                try {
                    await sock.rejectCall(call.id, call.from);
                    await blockUser(callerPhone, 'حظر تلقائي بسبب الاتصال');
                    await sendBotMessage(sock, call.from, {
                        text: `⛔ *تم حظرك نهائياً*\n\nالمكالمات غير مسموحة.\n\nللتواصل مع المطور:\n${INSTAGRAM_URL}${POWERED_BY}`
                    });
                } catch (error) {
                    console.error('❌ خطأ في رفض المكالمة:', error.message);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageType = Object.keys(msg.message)[0];
        if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

        const remoteJid = msg.key.remoteJid;
        const participant = msg.key.participant;
        const userId = getUserId(remoteJid, participant);
        const senderPhone = extractPhoneFromMessage(msg);
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!text) return;

        const userName = msg.pushName || 'مستخدم';
        const isAdmin = isDeveloper(senderPhone);

        console.log(`📨 رسالة من: ${senderPhone} | مطور: ${isAdmin} | النص: ${text.substring(0, 50)}`);

        const isBlacklisted = await checkBlacklist(senderPhone);
        if (isBlacklisted && !isAdmin) return;

        let session = userSessions.get(userId);
        if (session && session.isDownloading && !isAdmin) {
            const downloadSpamStatus = checkDownloadSpam(senderPhone);
            if (downloadSpamStatus === 'block') {
                stopDownloadTracking(senderPhone);
                await blockUser(senderPhone, 'حظر بسبب تجاوز حد التحميلات (10 متسارعة)');
                await sendBotMessage(sock, remoteJid, { 
                    text: `⛔ *تم حظرك نهائياً*\n\n❌ تجاوزت حد التحميل المسموح\n📊 الحد: 10 تحميلات متسارعة\n\n💡 نصيحة: اطلب كود VIP من المطور للتحميل اللامحدود!\n${INSTAGRAM_URL}${POWERED_BY}`
                }, msg);
                return;
            }
            await sendBotMessage(sock, remoteJid, { 
                text: `⏳ *انتظر قليلاً*\n\nجاري إرسال التطبيق...${POWERED_BY}`
            }, msg);
            return;
        }

        if (!isAdmin) {
            const hourlyStatus = checkHourlySpam(senderPhone);
            if (hourlyStatus === 'block') {
                await blockUser(senderPhone, 'حظر بسبب تجاوز حد الرسائل (25/ساعة)');
                await sendBotMessage(sock, remoteJid, { 
                    text: `⛔ *تم حظرك نهائياً*\n\n❌ تجاوزت حد الرسائل المسموح\n📊 الحد: 25 رسالة في الساعة الواحدة\n\nللاستفسار: ${INSTAGRAM_URL}${POWERED_BY}`
                }, msg);
                return;
            }
        }

        await updateUserActivity(senderPhone, userName);

        await processRequest(sock, userId, async () => {
            try {
                await new Promise(r => setTimeout(r, getRandomDelay(500, 2000)));
                await handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin);
            } catch (error) {
                console.error('❌ خطأ في معالجة الرسالة:', error);
                await sendBotMessage(sock, remoteJid, { text: `❌ حدث خطأ. حاول مرة أخرى.${POWERED_BY}` }, msg);
            }
        });
    });

    return sock;
}

async function handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin) {
    let session = userSessions.get(userId);
    const isNewUser = !session;
    if (!session) {
        session = { state: 'idle', searchResults: [], isDownloading: false, lastListMessageKey: null, firstTime: true };
        userSessions.set(userId, session);
    }

    const lowerText = text.toLowerCase().trim();

    if (text === VIP_PASSWORD) {
        vipUsers.add(senderPhone);
        stopDownloadTracking(senderPhone);
        await sendBotMessage(sock, remoteJid, { 
            text: `🌟 *تم تفعيل وضع VIP*

→ تحميل لامحدود
→ سرعة أسرع
→ أولوية في الطلبات${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === 'zarchiver' || lowerText === 'زارشيفر') {
        session.state = 'waiting_for_selection';
        session.searchResults = [{ title: 'ZArchiver', appId: ZARCHIVER_PACKAGE, developer: 'ZDevs', score: 4.5, index: 1 }];
        userSessions.set(userId, session);
        
        await sendBotMessage(sock, remoteJid, { 
            text: `📦 *جاري تحميل ZArchiver...*${POWERED_BY}`
        }, msg);
        
        await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, ZARCHIVER_PACKAGE, 'ZArchiver', session);
        return;
    }

    if (isNewUser && session.firstTime) {
        session.firstTime = false;
        const welcomeText = `🤖 *بوت AppOmar*

👋 أهلاً ${userName}

📱 *طريقة الاستخدام:*
← أرسل اسم التطبيق
← اختر الرقم من القائمة
← انتظر التحميل والإرسال

📋 *الأوامر المتاحة:*
→ /help - دليل المساعدة
→ /commands - جميع الأوامر
→ /history - سجل تحميلاتك
→ zarchiver - تحميل زارشيفر

📸 تابعني:
${INSTAGRAM_URL}${POWERED_BY}`;
        
        await sendBotMessage(sock, remoteJid, { text: welcomeText }, msg);
    }

    if (isAdmin) {
        console.log(`🔧 أمر المطور: ${text}`);

        if (text === '/stats' || text.startsWith('/stats')) {
            const stats = await getStats();
            if (stats) {
                let statsMsg = `📊 *إحصائيات البوت*

→ المستخدمين: ${stats.totalUsers}
→ التحميلات: ${stats.totalDownloads}
→ تحميلات اليوم: ${stats.todayDownloads}
→ الحجم الكلي: ${(stats.totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB
→ المحظورين: ${stats.blockedUsers}

🔥 *أكثر التطبيقات تحميلاً:*`;
                stats.topApps.forEach((app, i) => { statsMsg += `\n${i + 1}→ ${app.app_name} (${app.count})`; });
                statsMsg += POWERED_BY;
                await sendBotMessage(sock, remoteJid, { text: statsMsg }, msg);
            } else {
                await sendBotMessage(sock, remoteJid, { text: `❌ قاعدة البيانات غير متصلة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text.startsWith('/broadcast ')) {
            if (!dbEnabled) { 
                await sendBotMessage(sock, remoteJid, { text: `❌ قاعدة البيانات غير متصلة${POWERED_BY}` }, msg); 
                return; 
            }
            const message = text.replace('/broadcast ', '').trim();
            if (message) {
                await sendBotMessage(sock, remoteJid, { text: `📤 جاري إرسال الرسالة...${POWERED_BY}` }, msg);
                const result = await broadcastMessage(sock, message);
                await sendBotMessage(sock, remoteJid, { text: `✅ تم الإرسال\n\n✓ نجح: ${result.success}\n✗ فشل: ${result.failed}${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text.startsWith('/unblock ')) {
            const numberToUnblock = text.replace('/unblock ', '').trim();
            const success = await unblockUser(numberToUnblock);
            await sendBotMessage(sock, remoteJid, { text: success ? `✅ تم إلغاء حظر ${numberToUnblock}${POWERED_BY}` : `❌ فشل إلغاء الحظر${POWERED_BY}` }, msg);
            return;
        }

        if (text.startsWith('/block ')) {
            const numberToBlock = text.replace('/block ', '').trim();
            await blockUser(numberToBlock, 'حظر يدوي من المطور');
            await sendBotMessage(sock, remoteJid, { text: `✅ تم حظر ${numberToBlock}${POWERED_BY}` }, msg);
            return;
        }

        if (text === '/admin') {
            const adminHelp = `🔧 *أوامر المطور*

→ /stats - إحصائيات البوت
→ /broadcast [رسالة] - إرسال
→ /block [رقم] - حظر
→ /unblock [رقم] - إلغاء حظر${POWERED_BY}`;
            await sendBotMessage(sock, remoteJid, { text: adminHelp }, msg);
            return;
        }
    }

    if (lowerText === '/help' || lowerText === 'مساعدة' || lowerText === 'help') {
        const helpText = `╔═══════════════════╗
║  📖 *دليل المساعدة*  ║
╚═══════════════════╝

━━━━━━━━━━━━━━━━━━━━━

📱 *طريقة الاستخدام:*

1️⃣ أرسل اسم التطبيق الذي تريده
2️⃣ اختر رقم التطبيق من القائمة
3️⃣ انتظر التحميل والإرسال

━━━━━━━━━━━━━━━━━━━━━

📝 *الأوامر المتاحة:*

→ /help - دليل المساعدة
→ /commands - جميع الأوامر
→ /history - سجل تحميلاتك
→ /ping - فحص البوت
→ /info - معلومات البوت
→ /dev - التواصل مع المطور
→ zarchiver - تحميل زارشيفر

━━━━━━━━━━━━━━━━━━━━━

💡 *نصائح:*
• ابحث بالإنجليزية للحصول على نتائج أفضل
• ملفات XAPK تحتاج ZArchiver للتثبيت
• يمكنك البحث باسم الحزمة مباشرة

━━━━━━━━━━━━━━━━━━━━━

📸 تابعني على انستجرام:
${INSTAGRAM_URL}${POWERED_BY}`;
        
        const imageBuffer = await downloadBotProfileImage();
        if (imageBuffer) {
            await sendBotMessage(sock, remoteJid, { 
                image: imageBuffer, 
                caption: helpText 
            }, msg);
        } else {
            await sendBotMessage(sock, remoteJid, { text: helpText }, msg);
        }
        return;
    }

    if (lowerText === '/commands' || lowerText === 'الاوامر' || lowerText === 'اوامر') {
        const commandsText = `╔═══════════════════╗
║  📋 *قائمة الأوامر*  ║
╚═══════════════════╝

━━━━━━━━━━━━━━━━━━━━━

🔍 *البحث والتحميل:*

→ [اسم التطبيق] - للبحث عن تطبيق
→ zarchiver - تحميل برنامج زارشيفر

━━━━━━━━━━━━━━━━━━━━━

📊 *المعلومات والإحصائيات:*

→ /help - دليل المساعدة الكامل
→ /commands - عرض هذه القائمة
→ /history - سجل تحميلاتك الأخيرة
→ /ping - فحص سرعة البوت
→ /info - معلومات عن البوت
→ /dev - التواصل مع المطور

━━━━━━━━━━━━━━━━━━━━━

💬 *أمثلة للاستخدام:*

• WhatsApp
• Minecraft
• Free Fire
• com.example.app (اسم الحزمة)

${POWERED_BY}`;
        
        const imageBuffer = await downloadBotProfileImage();
        if (imageBuffer) {
            await sendBotMessage(sock, remoteJid, { 
                image: imageBuffer, 
                caption: commandsText 
            }, msg);
        } else {
            await sendBotMessage(sock, remoteJid, { text: commandsText }, msg);
        }
        return;
    }

    if (lowerText === '/ping' || lowerText === 'بينج') {
        const startTime = Date.now();
        await sendBotMessage(sock, remoteJid, { 
            text: `🏓 *PONG!*

→ السرعة: ${Date.now() - startTime}ms
→ الحالة: متصل ✅${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === '/info' || lowerText === 'معلومات') {
        const infoText = `ℹ️ *معلومات البوت*

→ الاسم: AppOmar Bot
→ الإصدار: 3.0.0
→ المطور: Omar
→ المصدر: APKPure

📊 *الإمكانيات:*
→ تحميل APK و XAPK
→ بحث في Google Play
→ إرسال الملفات مباشرة${POWERED_BY}`;
        await sendBotMessage(sock, remoteJid, { text: infoText }, msg);
        return;
    }

    if (lowerText === '/dev' || lowerText === 'المطور' || lowerText === 'تواصل') {
        const devText = `👨‍💻 *التواصل مع المطور*

📸 انستجرام:
${INSTAGRAM_URL}

→ للاستفسارات والاقتراحات
→ للحصول على كود VIP${POWERED_BY}`;
        await sendBotMessage(sock, remoteJid, { text: devText }, msg);
        return;
    }

    if (lowerText === '/history' || lowerText === 'سجلي' || lowerText === 'history') {
        const history = await getUserHistory(senderPhone);
        if (history.length === 0) {
            await sendBotMessage(sock, remoteJid, { 
                text: `📭 *لا يوجد سجل*

لم تقم بتحميل أي تطبيق بعد
أرسل اسم تطبيق للبحث${POWERED_BY}`
            }, msg);
        } else {
            let historyText = `📜 *سجل تحميلاتك*\n`;
            history.forEach((item, i) => {
                const date = new Date(item.created_at).toLocaleDateString('ar-EG');
                historyText += `\n${i + 1}→ ${item.app_name} (${item.file_type.toUpperCase()})`;
            });
            historyText += POWERED_BY;
            await sendBotMessage(sock, remoteJid, { text: historyText }, msg);
        }
        return;
    }

    if (session.state === 'idle' || session.state === 'waiting_for_search') {
        await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
        session.state = 'waiting_for_search';
        userSessions.set(userId, session);

        try {
            const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
            let results;
            if (isPackageName) {
                try {
                    const appDetails = await gplay.app({ appId: text.trim() });
                    results = [appDetails];
                } catch { 
                    results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' }); 
                }
            } else {
                results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' });
            }

            if (results.length === 0) {
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ *لا توجد نتائج*

لم أجد نتائج لـ "${text}"

💡 جرب البحث بالإنجليزية${POWERED_BY}`
                }, msg);
                return;
            }

            const cleanResults = results.map((app, idx) => ({
                title: app.title,
                appId: app.appId || app.id || app.packageName,
                developer: app.developer || '',
                score: app.score || 0,
                icon: app.icon || null,
                index: idx + 1
            }));

            session.searchResults = [...cleanResults];
            session.state = 'waiting_for_selection';

            const resultText = formatSearchResults(cleanResults) + POWERED_BY;

            const imageBuffer = await downloadBotProfileImage();
            let sentMsg;
            if (imageBuffer) {
                sentMsg = await sendBotMessage(sock, remoteJid, { image: imageBuffer, caption: resultText }, msg);
            } else {
                sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg);
            }
            session.lastListMessageKey = sentMsg?.key;
            userSessions.set(userId, session);

        } catch (error) {
            console.error('❌ خطأ في البحث:', error);
            await sendBotMessage(sock, remoteJid, { text: `❌ خطأ في البحث. حاول مرة أخرى.${POWERED_BY}` }, msg);
        }

    } else if (session.state === 'waiting_for_selection') {
        const selection = parseInt(text.trim());
        const resultsCount = session.searchResults?.length || 0;

        if (isNaN(selection) || selection < 1 || selection > resultsCount) {
            if (session.lastListMessageKey) {
                try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
                session.lastListMessageKey = null;
            }
            session.state = 'waiting_for_search';
            session.searchResults = [];
            userSessions.set(userId, session);

            await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });

            try {
                const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
                let results;
                if (isPackageName) {
                    try {
                        const appDetails = await gplay.app({ appId: text.trim() });
                        results = [appDetails];
                    } catch { 
                        results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' }); 
                    }
                } else {
                    results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' });
                }

                if (results.length === 0) {
                    await sendBotMessage(sock, remoteJid, { text: `❌ لم أجد نتائج لـ "${text}"${POWERED_BY}` }, msg);
                    return;
                }

                const cleanResults = results.map((app, idx) => ({
                    title: app.title,
                    appId: app.appId || app.id || app.packageName,
                    developer: app.developer || '',
                    score: app.score || 0,
                    icon: app.icon || null,
                    index: idx + 1
                }));

                session.searchResults = [...cleanResults];
                session.state = 'waiting_for_selection';

                const resultText = formatSearchResults(cleanResults) + POWERED_BY;

                const imageBuffer = await downloadBotProfileImage();
                let sentMsg;
                if (imageBuffer) {
                    sentMsg = await sendBotMessage(sock, remoteJid, { image: imageBuffer, caption: resultText }, msg);
                } else {
                    sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg);
                }
                session.lastListMessageKey = sentMsg?.key;
                userSessions.set(userId, session);
            } catch (error) {
                console.error('❌ خطأ في البحث:', error);
                await sendBotMessage(sock, remoteJid, { text: `❌ خطأ في البحث. حاول مرة أخرى.${POWERED_BY}` }, msg);
            }
            return;
        }

        const selectedApp = session.searchResults[selection - 1];
        await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, selectedApp.appId, selectedApp.title, session);
    }
}

async function handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appTitle, session) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    
    const selection = session.searchResults.findIndex(app => app.appId === appId) + 1;
    const emoji = numberEmojis[selection - 1] || '📱';
    await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } });

    if (session.lastListMessageKey) {
        try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
        session.lastListMessageKey = null;
    }

    session.isDownloading = true;
    startDownloadTracking(senderPhone);
    userSessions.set(userId, session);

    console.log(`✅ اختيار: ${appTitle} (${appId})`);

    if (!appId) {
        await sendBotMessage(sock, remoteJid, { text: `❌ خطأ في التطبيق. اختر آخر.${POWERED_BY}` }, msg);
        session.isDownloading = false;
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
        return;
    }

    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

    try {
        const appDetails = await gplay.app({ appId: appId });

        if (appDetails.icon) {
            try {
                const iconResponse = await axios.get(appDetails.icon, { 
                    responseType: 'arraybuffer',
                    timeout: 10000 
                });
                const stickerBuffer = await sharp(Buffer.from(iconResponse.data))
                    .resize(512, 512, {
                        fit: 'contain',
                        background: { r: 255, g: 255, b: 255, alpha: 0 }
                    })
                    .webp()
                    .toBuffer();
                await sendBotMessage(sock, remoteJid, {
                    sticker: stickerBuffer
                }, msg);
            } catch (iconError) {
                console.log('⚠️ فشل إرسال الأيقونة كملصق:', iconError.message);
            }
        }

        await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });

        const apkStream = await downloadAPKWithAxios(appDetails.appId, appDetails.title);

        if (apkStream) {
            if (apkStream.size > MAX_FILE_SIZE) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ *حجم كبير جداً*

→ حجم التطبيق: ${formatFileSize(apkStream.size)}
→ الحد الأقصى: 2 GB

💡 جرب تطبيق آخر${POWERED_BY}`
                }, msg);
                session.state = 'waiting_for_search';
                session.isDownloading = false;
                session.searchResults = [];
                stopDownloadTracking(senderPhone);
                userSessions.set(userId, session);
                return;
            }

            await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

            const isXapk = apkStream.fileType === 'xapk';
            await logDownload(senderPhone, appDetails.appId, appDetails.title, apkStream.fileType, apkStream.size);

            const caption = formatAppInfo(appDetails, apkStream.fileType, apkStream.size) + POWERED_BY;

            await sendBotMessage(sock, remoteJid, {
                document: apkStream.buffer,
                mimetype: isXapk ? 'application/octet-stream' : 'application/vnd.android.package-archive',
                fileName: apkStream.filename,
                caption: caption
            }, msg);

            if (isXapk) {
                await sendBotMessage(sock, remoteJid, { 
                    text: ZARCHIVER_TUTORIAL_BASIC + POWERED_BY
                }, msg);
            }

            await sendBotMessage(sock, remoteJid, { 
                text: `📸 تابعني على انستجرام:
${INSTAGRAM_URL}${POWERED_BY}` 
            }, msg);

        } else {
            await sendBotMessage(sock, remoteJid, { text: `❌ فشل التحميل. جرب تطبيق آخر.${POWERED_BY}` }, msg);
        }

        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    } catch (error) {
        console.error('❌ خطأ:', error);
        await sendBotMessage(sock, remoteJid, { text: `❌ حدث خطأ. حاول مرة أخرى.${POWERED_BY}` }, msg);
        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    }
}

console.log('🤖 بوت AppOmar الاحترافي');
console.log('🚀 جاري بدء البوت...\n');

await initDatabase();
await downloadBotProfileImage();

connectToWhatsApp().catch(err => {
    console.error('❌ خطأ فادح:', err);
    process.exit(1);
});
