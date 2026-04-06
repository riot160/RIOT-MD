const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  getContentType,
} = require('@whiskeysockets/baileys');

const {
  sendButtons,
  MessageQueue,
  GroupCache,
  createConversationFlow,
} = require('kango-wa');

const pino = require('pino');
const NodeCache = require('node-cache');
const readline = require('readline');
const config = require('./config');
const {
  formatJid,
  getSenderName,
  isGroup,
  isOwner,
  getGreeting,
  fetchApi,
  formatBytes,
  formatRuntime,
} = require('./lib/utils');

// ─── Globals ────────────────────────────────────────────────────
const START_TIME = Date.now();
const queue = new MessageQueue({ delay: 1200 });
const groupCache = new GroupCache();
const msgCache = new NodeCache({ stdTTL: 300, useClones: false });
const flows = new Map();
const logger = pino({ level: 'silent' });

// ─── Pairing Input ───────────────────────────────────────────────
const question = (text) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, (ans) => { rl.close(); res(ans.trim()); });
  });

// ─── Main Bot ────────────────────────────────────────────────────
async function startRiotMD() {
  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['RIOT MD', 'Chrome', '120.0.0'],
    markOnlineOnConnect: config.AUTO_ONLINE,
    cachedGroupMetadata: async (jid) => msgCache.get(jid),
    getMessage: async (key) => msgCache.get(key.id) || { conversation: '' },
  });

  // ── Pairing Code Auth ─────────────────────────────────────────
  if (!sock.authState.creds.registered) {
    let phone = await question('📱 Enter your WhatsApp number (with country code, no +):\n> ');
    phone = phone.replace(/[^0-9]/g, '');
    const code = await sock.requestPairingCode(phone);
    console.log(`\n🔐 Your Pairing Code: ${code}\n   Enter this in WhatsApp > Linked Devices > Link with phone number\n`);
  }

  // ── Connection Events ─────────────────────────────────────────
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`\n✅ RIOT MD connected as ${sock.user?.name || 'Bot'}`);
      console.log(`📌 Prefix: ${config.PREFIX}  |  Version: ${config.BOT_VERSION}\n`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        startRiotMD();
      } else {
        console.log('❌ Logged out. Delete auth_info and restart.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Cache group metadata
  sock.ev.on('groups.update', async ([event]) => {
    const meta = await sock.groupMetadata(event.id).catch(() => null);
    if (meta) msgCache.set(event.id, meta);
  });

  // ── Message Handler ───────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const msgType = getContentType(msg.message);
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.buttonResponseMessage?.selectedButtonId ||
          '';

        const isCmd = body.startsWith(config.PREFIX);
        const cmd = isCmd ? body.slice(config.PREFIX.length).split(' ')[0].toLowerCase() : '';
        const args = body.split(' ').slice(1);
        const text = args.join(' ');
        const senderName = getSenderName(msg);
        const isGrp = isGroup(chatId);
        const isOwnerMsg = isOwner(sender, config.OWNER_NUMBER);

        // Auto read
        if (config.AUTO_READ) {
          await sock.readMessages([msg.key]);
        }

        // Auto typing indicator
        if (config.AUTO_TYPING && isCmd) {
          await sock.sendPresenceUpdate('composing', chatId);
        }

        // ── Active Flow Check ──────────────────────────────────
        if (flows.has(sender)) {
          const flow = flows.get(sender);
          const done = await flow.next(body);
          if (done) flows.delete(sender);
          continue;
        }

        if (!isCmd) continue;

        // ── Reply Helper ───────────────────────────────────────
        const reply = (text) =>
          queue.add(() =>
            sock.sendMessage(chatId, { text }, { quoted: msg })
          );

        // ── React Helper ───────────────────────────────────────
        const react = (emoji) =>
          sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } });

        // ══════════════════════════════════════════════════════
        //                    COMMANDS
        // ══════════════════════════════════════════════════════

        switch (cmd) {

          // ───────────── GENERAL ─────────────────────────────

          case 'menu':
          case 'help': {
            await react('📋');
            await sendButtons(sock, chatId, {
              text:
                `╔══════════════════╗\n` +
                `║   *RIOT MD* v${config.BOT_VERSION}  ║\n` +
                `╚══════════════════╝\n\n` +
                `${getGreeting()}, *${senderName}!* 👋\n\n` +
                `Choose a category:`,
              footer: `Prefix: ${config.PREFIX} | RIOT MD`,
              buttons: [
                { id: 'cat_general', text: '🌐 General' },
                { id: 'cat_group', text: '👥 Group Tools' },
                { id: 'cat_fun', text: '🎲 Fun & Games' },
                { id: 'cat_owner', text: '👑 Owner Only' },
              ],
            });
            break;
          }

          case 'cat_general': {
            await reply(
              `*🌐 GENERAL COMMANDS*\n\n` +
              `${config.PREFIX}ping — Check bot speed\n` +
              `${config.PREFIX}info — Bot information\n` +
              `${config.PREFIX}runtime — Uptime\n` +
              `${config.PREFIX}weather <city> — Weather info\n` +
              `${config.PREFIX}joke — Random joke\n` +
              `${config.PREFIX}quote — Motivational quote\n` +
              `${config.PREFIX}calc <expr> — Calculator\n` +
              `${config.PREFIX}define <word> — Dictionary\n` +
              `${config.PREFIX}time — Current time\n` +
              `${config.PREFIX}register — Register yourself`
            );
            break;
          }

          case 'cat_group': {
            await reply(
              `*👥 GROUP COMMANDS*\n\n` +
              `${config.PREFIX}groupinfo — Group details\n` +
              `${config.PREFIX}members — List members\n` +
              `${config.PREFIX}admins — List admins\n` +
              `${config.PREFIX}kick @user — Remove member*\n` +
              `${config.PREFIX}promote @user — Make admin*\n` +
              `${config.PREFIX}demote @user — Remove admin*\n` +
              `${config.PREFIX}mute — Mute group*\n` +
              `${config.PREFIX}unmute — Unmute group*\n` +
              `${config.PREFIX}link — Get invite link*\n` +
              `${config.PREFIX}revoke — Reset invite link*\n\n` +
              `_* Admin only_`
            );
            break;
          }

          case 'cat_fun': {
            await reply(
              `*🎲 FUN COMMANDS*\n\n` +
              `${config.PREFIX}joke — Random joke\n` +
              `${config.PREFIX}quote — Random quote\n` +
              `${config.PREFIX}flip — Flip a coin\n` +
              `${config.PREFIX}roll — Roll a dice\n` +
              `${config.PREFIX}roast — Get roasted 😈\n` +
              `${config.PREFIX}fact — Random fun fact\n` +
              `${config.PREFIX}ship @user — Ship two people\n` +
              `${config.PREFIX}8ball <q> — Magic 8-ball`
            );
            break;
          }

          case 'cat_owner': {
            if (!isOwnerMsg) return reply('❌ Owner only command!');
            await reply(
              `*👑 OWNER COMMANDS*\n\n` +
              `${config.PREFIX}broadcast <msg> — Broadcast (reply to chat)\n` +
              `${config.PREFIX}block @user — Block user\n` +
              `${config.PREFIX}unblock @user — Unblock user\n` +
              `${config.PREFIX}setname <name> — Change bot name\n` +
              `${config.PREFIX}setstatus <text> — Change bio\n` +
              `${config.PREFIX}restart — Restart bot`
            );
            break;
          }

          // ───────────── PING / INFO ──────────────────────────

          case 'ping': {
            const start = Date.now();
            await reply(`🏓 Pong! *${Date.now() - start}ms*`);
            break;
          }

          case 'info': {
            await react('ℹ️');
            await reply(
              `╔══════════════════╗\n` +
              `║    *RIOT MD INFO*    ║\n` +
              `╚══════════════════╝\n\n` +
              `🤖 *Bot:* RIOT MD\n` +
              `📌 *Version:* ${config.BOT_VERSION}\n` +
              `⚡ *Engine:* Baileys + kango-wa\n` +
              `👑 *Owner:* ${config.OWNER_NAME}\n` +
              `🔑 *Prefix:* ${config.PREFIX}\n` +
              `⏱️ *Uptime:* ${formatRuntime((Date.now() - START_TIME) / 1000)}`
            );
            break;
          }

          case 'runtime': {
            await reply(`⏱️ *RIOT MD Uptime:*\n${formatRuntime((Date.now() - START_TIME) / 1000)}`);
            break;
          }

          case 'time': {
            const now = new Date();
            await reply(
              `🕐 *Current Time*\n\n` +
              `📅 Date: ${now.toDateString()}\n` +
              `⏰ Time: ${now.toLocaleTimeString()}\n` +
              `🌍 Zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
            );
            break;
          }

          // ───────────── FUN ──────────────────────────────────

          case 'flip': {
            const result = Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!';
            await react('🪙');
            await reply(result);
            break;
          }

          case 'roll': {
            const dice = Math.floor(Math.random() * 6) + 1;
            await react('🎲');
            await reply(`🎲 You rolled: *${dice}*`);
            break;
          }

          case 'roast': {
            const roasts = [
              "You're the human version of a participation trophy.",
              "I'd roast you but my mom said I'm not allowed to burn trash.",
              "You have your whole life to be an idiot. Take the day off.",
              "If laughter is the best medicine, your face must be curing diseases.",
              "I'd explain it to you, but I don't have the crayons.",
              "You're not stupid; you just have bad luck thinking.",
            ];
            await react('🔥');
            await reply(`🔥 *Roast:*\n_${roasts[Math.floor(Math.random() * roasts.length)]}_`);
            break;
          }

          case 'flip':
          case '8ball': {
            const answers = [
              '✅ Yes, definitely!', '✅ Without a doubt.',
              '✅ Most likely.', '🤔 Ask again later.',
              '🤔 Cannot predict now.', '❌ Don\'t count on it.',
              '❌ My sources say no.', '❌ Very doubtful.',
            ];
            if (!text) return reply('❓ Ask a question! e.g. `.8ball Will I be rich?`');
            await react('🎱');
            await reply(`🎱 *Magic 8-Ball*\n\n❓ ${text}\n\n${answers[Math.floor(Math.random() * answers.length)]}`);
            break;
          }

          case 'ship': {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const p1 = senderName;
            const p2 = mentioned[0] ? formatJid(mentioned[0]) : 'Mystery Person';
            const percent = Math.floor(Math.random() * 101);
            const bar = '💗'.repeat(Math.floor(percent / 10)) + '🖤'.repeat(10 - Math.floor(percent / 10));
            await react('💘');
            await reply(`💘 *Ship Meter*\n\n👤 ${p1} + 👤 ${p2}\n\n${bar}\n*${percent}% compatible!*`);
            break;
          }

          case 'fact': {
            const data = await fetchApi('https://uselessfacts.jsph.pl/random.json?language=en');
            await react('🧠');
            await reply(`🧠 *Random Fact:*\n\n${data?.text || 'Could not fetch a fact right now.'}`);
            break;
          }

          case 'joke': {
            const data = await fetchApi('https://official-joke-api.appspot.com/random_joke');
            await react('😂');
            if (data) {
              await reply(`😂 *Joke Time!*\n\n${data.setup}\n\n_${data.punchline}_`);
            } else {
              await reply('😂 Why do programmers prefer dark mode? Because light attracts bugs!');
            }
            break;
          }

          case 'quote': {
            const data = await fetchApi('https://zenquotes.io/api/random');
            await react('💬');
            if (data?.[0]) {
              await reply(`💬 *Quote of the moment:*\n\n_"${data[0].q}"_\n\n— *${data[0].a}*`);
            } else {
              await reply('💬 "The only way to do great work is to love what you do." — Steve Jobs');
            }
            break;
          }

          case 'calc': {
            if (!text) return reply('❓ Usage: `.calc 5 * 10 + 2`');
            try {
              // Safe eval using Function (basic math only)
              const sanitized = text.replace(/[^0-9+\-*/.() ]/g, '');
              const result = Function(`"use strict"; return (${sanitized})`)();
              await react('🧮');
              await reply(`🧮 *Calculator*\n\n📥 Input: ${text}\n📤 Result: *${result}*`);
            } catch {
              await reply('❌ Invalid expression. Use: `.calc 5 * 10 / 2`');
            }
            break;
          }

          case 'weather': {
            if (!text) return reply('❓ Usage: `.weather Nairobi`');
            const data = await fetchApi(
              `https://wttr.in/${encodeURIComponent(text)}?format=j1`
            );
            if (!data) return reply('❌ Could not fetch weather. Try again later.');
            const cur = data.current_condition?.[0];
            const area = data.nearest_area?.[0];
            await react('🌤️');
            await reply(
              `🌤️ *Weather — ${area?.areaName?.[0]?.value || text}*\n\n` +
              `🌡️ Temp: ${cur?.temp_C}°C / ${cur?.temp_F}°F\n` +
              `💧 Humidity: ${cur?.humidity}%\n` +
              `💨 Wind: ${cur?.windspeedKmph} km/h\n` +
              `☁️ Condition: ${cur?.weatherDesc?.[0]?.value}`
            );
            break;
          }

          case 'define': {
            if (!text) return reply('❓ Usage: `.define serendipity`');
            const data = await fetchApi(`https://api.dictionaryapi.dev/api/v2/entries/en/${text}`);
            if (!data?.[0]) return reply(`❌ No definition found for *${text}*`);
            const entry = data[0];
            const meaning = entry.meanings?.[0];
            const def = meaning?.definitions?.[0];
            await react('📖');
            await reply(
              `📖 *Dictionary*\n\n` +
              `🔤 Word: *${entry.word}*\n` +
              `📝 Type: ${meaning?.partOfSpeech}\n` +
              `💡 Meaning: ${def?.definition}\n` +
              `📌 Example: ${def?.example || 'N/A'}`
            );
            break;
          }

          // ───────────── GROUP TOOLS ──────────────────────────

          case 'groupinfo': {
            if (!isGrp) return reply('❌ This command works in groups only!');
            const meta = await groupCache.get(sock, chatId);
            await react('👥');
            await reply(
              `👥 *Group Info*\n\n` +
              `📌 Name: ${meta.subject}\n` +
              `🆔 ID: ${chatId}\n` +
              `👤 Members: ${meta.participants.length}\n` +
              `📅 Created: ${new Date(meta.creation * 1000).toDateString()}\n` +
              `📝 Description: ${meta.desc || 'None'}`
            );
            break;
          }

          case 'members': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const list = meta.participants
              .map((p, i) => `${i + 1}. +${formatJid(p.id)}${p.admin ? ' 👑' : ''}`)
              .join('\n');
            await reply(`👥 *Members (${meta.participants.length})*\n\n${list}`);
            break;
          }

          case 'admins': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const admins = meta.participants.filter((p) => p.admin);
            const list = admins.map((p, i) => `${i + 1}. +${formatJid(p.id)} (${p.admin})`).join('\n');
            await reply(`👑 *Admins (${admins.length})*\n\n${list}`);
            break;
          }

          case 'link': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            const code = await sock.groupInviteCode(chatId);
            await reply(`🔗 *Group Invite Link*\nhttps://chat.whatsapp.com/${code}`);
            break;
          }

          case 'revoke': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            await sock.groupRevokeInvite(chatId);
            await reply('✅ Invite link has been reset!');
            break;
          }

          case 'kick': {
            if (!isGrp) return reply('❌ Groups only!');
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) return reply('❌ Tag someone to kick! e.g. `.kick @user`');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            await sock.groupParticipantsUpdate(chatId, mentioned, 'remove');
            await react('🚫');
            await reply(`🚫 *Kicked* ${mentioned.length} member(s).`);
            break;
          }

          case 'promote': {
            if (!isGrp) return reply('❌ Groups only!');
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) return reply('❌ Tag someone to promote!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            await sock.groupParticipantsUpdate(chatId, mentioned, 'promote');
            await react('👑');
            await reply(`👑 Promoted ${mentioned.length} member(s) to admin!`);
            break;
          }

          case 'demote': {
            if (!isGrp) return reply('❌ Groups only!');
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) return reply('❌ Tag someone to demote!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            await sock.groupParticipantsUpdate(chatId, mentioned, 'demote');
            await react('⬇️');
            await reply(`⬇️ Demoted ${mentioned.length} member(s) from admin.`);
            break;
          }

          case 'mute': {
            if (!isGrp) return reply('❌ Groups only!');
            await sock.groupSettingUpdate(chatId, 'announcement');
            await react('🔇');
            await reply('🔇 Group muted — only admins can send messages.');
            break;
          }

          case 'unmute': {
            if (!isGrp) return reply('❌ Groups only!');
            await sock.groupSettingUpdate(chatId, 'not_announcement');
            await react('🔊');
            await reply('🔊 Group unmuted — everyone can send messages.');
            break;
          }

          // ───────────── OWNER ONLY ───────────────────────────

          case 'setname': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            if (!text) return reply('❓ Usage: `.setname Cool Bot`');
            await sock.updateProfileName(text);
            await reply(`✅ Bot name changed to: *${text}*`);
            break;
          }

          case 'setstatus': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            if (!text) return reply('❓ Usage: `.setstatus I am RIOT MD`');
            await sock.updateProfileStatus(text);
            await reply(`✅ Status updated to: _${text}_`);
            break;
          }

          case 'block': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) return reply('❌ Tag someone to block!');
            await sock.updateBlockStatus(mentioned[0], 'block');
            await reply(`✅ Blocked +${formatJid(mentioned[0])}`);
            break;
          }

          case 'unblock': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) return reply('❌ Tag someone to unblock!');
            await sock.updateBlockStatus(mentioned[0], 'unblock');
            await reply(`✅ Unblocked +${formatJid(mentioned[0])}`);
            break;
          }

          case 'restart': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            await reply('♻️ Restarting RIOT MD...');
            process.exit(0); // Railway/PM2 will auto-restart
            break;
          }

          // ───────────── REGISTER FLOW ─────────────────────────

          case 'register': {
            if (flows.has(sender)) return reply('⚠️ You already have an active session. Complete it first.');
            const userData = {};

            const flow = createConversationFlow([
              {
                prompt: `📝 *RIOT MD Registration*\n\nStep 1/3 — What's your *name*?`,
                key: 'name',
                validate: (v) => v.length >= 2 || '❌ Name must be at least 2 characters.',
              },
              {
                prompt: `Step 2/3 — What's your *age*?`,
                key: 'age',
                validate: (v) => (!isNaN(v) && v > 0) || '❌ Please enter a valid age number.',
              },
              {
                prompt: `Step 3/3 — What's your *country*?`,
                key: 'country',
              },
            ], async (collected) => {
              await sock.sendMessage(chatId, {
                text:
                  `✅ *Registration Complete!*\n\n` +
                  `👤 Name: ${collected.name}\n` +
                  `🎂 Age: ${collected.age}\n` +
                  `🌍 Country: ${collected.country}\n\n` +
                  `Welcome to *RIOT MD*, ${collected.name}! 🎉`,
              }, { quoted: msg });
              flows.delete(sender);
            });

            flows.set(sender, flow);
            await reply(flow.currentPrompt());
            break;
          }

          // ───────────── DEFAULT ───────────────────────────────

          default: {
            await react('❓');
            await reply(`❓ Unknown command: *${config.PREFIX}${cmd}*\n\nType *${config.PREFIX}menu* to see all commands.`);
          }
        }

      } catch (err) {
        console.error('[Error]', err.message);
      }
    }
  });
}

// ─── Launch ──────────────────────────────────────────────────────
console.log(`
╔══════════════════════════╗
║   🤖  R I O T   M D     ║
║   WhatsApp Bot v1.0.0   ║
╚══════════════════════════╝
`);
startRiotMD();