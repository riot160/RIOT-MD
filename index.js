'use strict';

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
  formatRuntime,
} = require('./lib/utils');

// ─── Start Time ──────────────────────────────────────────────────
const START_TIME = Date.now();

// ─── Custom Message Queue (prevents bans) ────────────────────────
const queue = {
  _queue: [],
  _running: false,
  _delay: 1200,
  add(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._running) this._run();
    });
  },
  async _run() {
    this._running = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try { resolve(await fn()); } catch (e) { reject(e); }
      await new Promise(r => setTimeout(r, this._delay));
    }
    this._running = false;
  },
};

// ─── Caches ──────────────────────────────────────────────────────
const groupCache = new GroupCache();
const msgCache = new NodeCache({ stdTTL: 300, useClones: false });
const flows = new Map();
const logger = pino({ level: 'silent' });

// ─── Pairing Input ───────────────────────────────────────────────
const question = (text) =>
  new Promise((res) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(text, (ans) => { rl.close(); res(ans.trim()); });
  });

// ════════════════════════════════════════════════════════════════
//                        MAIN BOT
// ════════════════════════════════════════════════════════════════
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
    let phone = await question(
      '📱 Enter your WhatsApp number (with country code, no +):\n> '
    );
    phone = phone.replace(/[^0-9]/g, '');
    const code = await sock.requestPairingCode(phone);
    console.log(`\n🔐 Pairing Code: ${code}`);
    console.log('   Go to WhatsApp → Linked Devices → Link with phone number\n');
  }

  // ── Connection Events ─────────────────────────────────────────
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`✅ RIOT MD connected as ${sock.user?.name || 'Bot'}`);
      console.log(`📌 Prefix: ${config.PREFIX}  |  v${config.BOT_VERSION}\n`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        startRiotMD();
      } else {
        console.log('❌ Logged out. Delete auth_info folder and restart.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Cache group metadata on updates
  sock.ev.on('groups.update', async ([event]) => {
    const meta = await sock.groupMetadata(event.id).catch(() => null);
    if (meta) msgCache.set(event.id, meta);
  });

  sock.ev.on('group-participants.update', async (event) => {
    const meta = await sock.groupMetadata(event.id).catch(() => null);
    if (meta) msgCache.set(event.id, meta);
  });

  // ════════════════════════════════════════════════════════════════
  //                     MESSAGE HANDLER
  // ════════════════════════════════════════════════════════════════
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;

        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.buttonResponseMessage?.selectedButtonId ||
          '';

        const isCmd = body.startsWith(config.PREFIX);
        const cmd = isCmd
          ? body.slice(config.PREFIX.length).split(' ')[0].toLowerCase()
          : '';
        const args = body.split(' ').slice(1);
        const text = args.join(' ');
        const senderName = getSenderName(msg);
        const isGrp = isGroup(chatId);
        const isOwnerMsg = isOwner(sender, config.OWNER_NUMBER);

        // Auto read
        if (config.AUTO_READ) {
          await sock.readMessages([msg.key]).catch(() => {});
        }

        // Auto typing
        if (config.AUTO_TYPING && isCmd) {
          await sock.sendPresenceUpdate('composing', chatId).catch(() => {});
        }

        // ── Active Conversation Flow ───────────────────────────
        if (flows.has(sender)) {
          const flow = flows.get(sender);
          const done = await flow.next(body);
          if (done) flows.delete(sender);
          continue;
        }

        if (!isCmd) continue;

        // ── Helpers ───────────────────────────────────────────
        const reply = (text) =>
          queue.add(() =>
            sock.sendMessage(chatId, { text }, { quoted: msg })
          );

        const react = (emoji) =>
          sock.sendMessage(chatId, {
            react: { text: emoji, key: msg.key },
          }).catch(() => {});

        // ════════════════════════════════════════════════════════
        //                     COMMANDS
        // ════════════════════════════════════════════════════════
        switch (cmd) {

          // ═══════════════ MENU ══════════════════════════════
          case 'menu':
          case 'help': {
            await react('📋');
            await sendButtons(sock, chatId, {
              text:
                `╔══════════════════════╗\n` +
                `║   🤖  *RIOT MD*  v${config.BOT_VERSION}   ║\n` +
                `╚══════════════════════╝\n\n` +
                `${getGreeting()}, *${senderName}!* 👋\n\n` +
                `Choose a command category:`,
              footer: `Prefix: ${config.PREFIX}  |  RIOT MD`,
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
              `${config.PREFIX}runtime — Bot uptime\n` +
              `${config.PREFIX}time — Current time & date\n` +
              `${config.PREFIX}weather <city> — Weather info\n` +
              `${config.PREFIX}define <word> — Dictionary\n` +
              `${config.PREFIX}calc <expr> — Calculator\n` +
              `${config.PREFIX}quote — Motivational quote\n` +
              `${config.PREFIX}joke — Random joke\n` +
              `${config.PREFIX}fact — Random fun fact\n` +
              `${config.PREFIX}register — Register yourself`
            );
            break;
          }

          case 'cat_group': {
            await reply(
              `*👥 GROUP COMMANDS*\n\n` +
              `${config.PREFIX}groupinfo — Group details\n` +
              `${config.PREFIX}members — List all members\n` +
              `${config.PREFIX}admins — List admins\n` +
              `${config.PREFIX}link — Get invite link ⭐\n` +
              `${config.PREFIX}revoke — Reset invite link ⭐\n` +
              `${config.PREFIX}kick @user — Remove member ⭐\n` +
              `${config.PREFIX}promote @user — Make admin ⭐\n` +
              `${config.PREFIX}demote @user — Remove admin ⭐\n` +
              `${config.PREFIX}mute — Mute group ⭐\n` +
              `${config.PREFIX}unmute — Unmute group ⭐\n\n` +
              `_⭐ = Admin only_`
            );
            break;
          }

          case 'cat_fun': {
            await reply(
              `*🎲 FUN COMMANDS*\n\n` +
              `${config.PREFIX}joke — Random joke\n` +
              `${config.PREFIX}quote — Motivational quote\n` +
              `${config.PREFIX}fact — Random fun fact\n` +
              `${config.PREFIX}flip — Flip a coin\n` +
              `${config.PREFIX}roll — Roll a dice\n` +
              `${config.PREFIX}roast — Get roasted 🔥\n` +
              `${config.PREFIX}8ball <question> — Magic 8-ball\n` +
              `${config.PREFIX}ship @user — Ship meter 💘`
            );
            break;
          }

          case 'cat_owner': {
            if (!isOwnerMsg) return reply('❌ Owner only command!');
            await reply(
              `*👑 OWNER COMMANDS*\n\n` +
              `${config.PREFIX}setname <name> — Change bot name\n` +
              `${config.PREFIX}setstatus <text> — Change bio\n` +
              `${config.PREFIX}block @user — Block a user\n` +
              `${config.PREFIX}unblock @user — Unblock a user\n` +
              `${config.PREFIX}restart — Restart the bot`
            );
            break;
          }

          // ═══════════════ GENERAL ═══════════════════════════

          case 'ping': {
            const t1 = Date.now();
            await reply(`🏓 Pong!\n⚡ Speed: *${Date.now() - t1}ms*`);
            break;
          }

          case 'info': {
            await react('ℹ️');
            await reply(
              `╔══════════════════════╗\n` +
              `║    *RIOT MD  INFO*     ║\n` +
              `╚══════════════════════╝\n\n` +
              `🤖 *Name:* RIOT MD\n` +
              `📌 *Version:* ${config.BOT_VERSION}\n` +
              `⚡ *Engine:* Baileys + kango-wa\n` +
              `👑 *Owner:* ${config.OWNER_NAME}\n` +
              `🔑 *Prefix:* ${config.PREFIX}\n` +
              `⏱️ *Uptime:* ${formatRuntime((Date.now() - START_TIME) / 1000)}\n` +
              `🌐 *Platform:* Railway`
            );
            break;
          }

          case 'runtime': {
            await react('⏱️');
            await reply(
              `⏱️ *RIOT MD Uptime*\n\n` +
              `${formatRuntime((Date.now() - START_TIME) / 1000)}`
            );
            break;
          }

          case 'time': {
            const now = new Date();
            await react('🕐');
            await reply(
              `🕐 *Date & Time*\n\n` +
              `📅 Date: ${now.toDateString()}\n` +
              `⏰ Time: ${now.toLocaleTimeString()}\n` +
              `🌍 Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
            );
            break;
          }

          case 'weather': {
            if (!text) return reply(`❓ Usage: *${config.PREFIX}weather Nairobi*`);
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
            if (!text) return reply(`❓ Usage: *${config.PREFIX}define serendipity*`);
            const data = await fetchApi(
              `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`
            );
            if (!data?.[0]) return reply(`❌ No definition found for *${text}*`);
            const meaning = data[0].meanings?.[0];
            const def = meaning?.definitions?.[0];
            await react('📖');
            await reply(
              `📖 *Dictionary*\n\n` +
              `🔤 Word: *${data[0].word}*\n` +
              `📝 Type: _${meaning?.partOfSpeech}_\n` +
              `💡 Meaning: ${def?.definition}\n` +
              `📌 Example: ${def?.example || 'N/A'}`
            );
            break;
          }

          case 'calc': {
            if (!text) return reply(`❓ Usage: *${config.PREFIX}calc 5 * 10 + 2*`);
            try {
              const sanitized = text.replace(/[^0-9+\-*/.() ]/g, '');
              const result = Function(`"use strict"; return (${sanitized})`)();
              await react('🧮');
              await reply(
                `🧮 *Calculator*\n\n` +
                `📥 Input: \`${text}\`\n` +
                `📤 Result: *${result}*`
              );
            } catch {
              await reply('❌ Invalid expression. Example: `.calc 50 * 2 / 5`');
            }
            break;
          }

          case 'quote': {
            const data = await fetchApi('https://zenquotes.io/api/random');
            await react('💬');
            if (data?.[0]) {
              await reply(
                `💬 *Quote of the Moment*\n\n` +
                `_"${data[0].q}"_\n\n— *${data[0].a}*`
              );
            } else {
              await reply(
                `💬 *Quote of the Moment*\n\n` +
                `_"The only way to do great work is to love what you do."_\n\n— *Steve Jobs*`
              );
            }
            break;
          }

          case 'joke': {
            const data = await fetchApi(
              'https://official-joke-api.appspot.com/random_joke'
            );
            await react('😂');
            if (data) {
              await reply(`😂 *Joke Time!*\n\n${data.setup}\n\n_${data.punchline}_ 🥁`);
            } else {
              await reply(
                `😂 *Joke Time!*\n\nWhy do programmers prefer dark mode?\n\n_Because light attracts bugs!_ 🐛`
              );
            }
            break;
          }

          case 'fact': {
            const data = await fetchApi(
              'https://uselessfacts.jsph.pl/random.json?language=en'
            );
            await react('🧠');
            await reply(
              `🧠 *Random Fact*\n\n${data?.text || 'Honey never spoils. 3000-year-old honey found in Egyptian tombs is still edible!'}`
            );
            break;
          }

          // ═══════════════ FUN ═══════════════════════════════

          case 'flip': {
            await react('🪙');
            await reply(`🪙 *Coin Flip*\n\nResult: *${Math.random() < 0.5 ? 'Heads!' : 'Tails!'}*`);
            break;
          }

          case 'roll': {
            const dice = Math.floor(Math.random() * 6) + 1;
            await react('🎲');
            await reply(`🎲 *Dice Roll*\n\nYou rolled: *${dice}*`);
            break;
          }

          case 'roast': {
            const roasts = [
              "You're the human version of a participation trophy.",
              "I'd roast you but my mom said I'm not allowed to burn trash.",
              "You have your whole life to be an idiot. Take the day off.",
              "If laughter is the best medicine, your face must be curing diseases.",
              "I'd explain it to you but I don't have the crayons.",
              "You're not stupid — you just have bad luck thinking.",
              "I've seen better heads on a pimple.",
              "You bring everyone so much joy... when you leave the room.",
            ];
            await react('🔥');
            await reply(
              `🔥 *You got roasted!*\n\n_${roasts[Math.floor(Math.random() * roasts.length)]}_`
            );
            break;
          }

          case '8ball': {
            const answers = [
              '✅ Yes, definitely!',
              '✅ Without a doubt.',
              '✅ Most likely.',
              '✅ Signs point to yes.',
              '🤔 Ask again later.',
              '🤔 Cannot predict now.',
              '🤔 Concentrate and ask again.',
              '❌ Don\'t count on it.',
              '❌ My sources say no.',
              '❌ Very doubtful.',
              '❌ Outlook not so good.',
            ];
            if (!text) return reply(`❓ Usage: *${config.PREFIX}8ball Will I be rich?*`);
            await react('🎱');
            await reply(
              `🎱 *Magic 8-Ball*\n\n` +
              `❓ ${text}\n\n` +
              `${answers[Math.floor(Math.random() * answers.length)]}`
            );
            break;
          }

          case 'ship': {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const p1 = senderName;
            const p2 = mentioned[0] ? `+${formatJid(mentioned[0])}` : 'Mystery Person 👤';
            const percent = Math.floor(Math.random() * 101);
            const filled = Math.floor(percent / 10);
            const bar = '💗'.repeat(filled) + '🖤'.repeat(10 - filled);
            await react('💘');
            await reply(
              `💘 *Ship Meter*\n\n` +
              `👤 ${p1}  +  👤 ${p2}\n\n` +
              `${bar}\n\n` +
              `*${percent}% compatible!*\n` +
              `${percent >= 70 ? '🔥 Perfect match!' : percent >= 40 ? '🌸 Could work!' : '💔 Hmm... maybe not.'}`
            );
            break;
          }

          // ═══════════════ GROUP TOOLS ════════════════════════

          case 'groupinfo': {
            if (!isGrp) return reply('❌ This command works in groups only!');
            const meta = await groupCache.get(sock, chatId);
            await react('👥');
            await reply(
              `👥 *Group Info*\n\n` +
              `📌 Name: *${meta.subject}*\n` +
              `🆔 ID: ${chatId}\n` +
              `👤 Members: ${meta.participants.length}\n` +
              `📅 Created: ${new Date(meta.creation * 1000).toDateString()}\n` +
              `📝 Desc: ${meta.desc || 'None'}`
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
            if (!admins.length) return reply('❌ No admins found.');
            const list = admins
              .map((p, i) => `${i + 1}. +${formatJid(p.id)} _(${p.admin})_`)
              .join('\n');
            await reply(`👑 *Admins (${admins.length})*\n\n${list}`);
            break;
          }

          case 'link': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const botIsAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sock.user.id) && p.admin
            );
            if (!botIsAdmin && !isOwnerMsg)
              return reply('❌ Make RIOT MD an admin first!');
            const code = await sock.groupInviteCode(chatId);
            await react('🔗');
            await reply(`🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}`);
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
            await react('🔄');
            await reply('✅ Invite link has been reset successfully!');
            break;
          }

          case 'kick': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            const mentioned =
              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length)
              return reply(`❓ Usage: *${config.PREFIX}kick @user*`);
            await sock.groupParticipantsUpdate(chatId, mentioned, 'remove');
            await react('🚫');
            await reply(`🚫 Kicked *${mentioned.length}* member(s) from the group.`);
            break;
          }

          case 'promote': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            const mentioned =
              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length)
              return reply(`❓ Usage: *${config.PREFIX}promote @user*`);
            await sock.groupParticipantsUpdate(chatId, mentioned, 'promote');
            await react('👑');
            await reply(`👑 Promoted *${mentioned.length}* member(s) to admin!`);
            break;
          }

          case 'demote': {
            if (!isGrp) return reply('❌ Groups only!');
            const meta = await groupCache.get(sock, chatId);
            const isAdmin = meta.participants.find(
              (p) => formatJid(p.id) === formatJid(sender) && p.admin
            );
            if (!isAdmin && !isOwnerMsg) return reply('❌ Admins only!');
            const mentioned =
              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length)
              return reply(`❓ Usage: *${config.PREFIX}demote @user*`);
            await sock.groupParticipantsUpdate(chatId, mentioned, 'demote');
            await react('⬇️');
            await reply(`⬇️ Demoted *${mentioned.length}* member(s) from admin.`);
            break;
          }

          case 'mute': {
            if (!isGrp) return reply('❌ Groups only!');
            await sock.groupSettingUpdate(chatId, 'announcement');
            await react('🔇');
            await reply('🔇 Group *muted* — only admins can send messages now.');
            break;
          }

          case 'unmute': {
            if (!isGrp) return reply('❌ Groups only!');
            await sock.groupSettingUpdate(chatId, 'not_announcement');
            await react('🔊');
            await reply('🔊 Group *unmuted* — everyone can send messages now.');
            break;
          }

          // ═══════════════ OWNER ONLY ═════════════════════════

          case 'setname': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            if (!text) return reply(`❓ Usage: *${config.PREFIX}setname RIOT MD Pro*`);
            await sock.updateProfileName(text);
            await reply(`✅ Bot name updated to: *${text}*`);
            break;
          }

          case 'setstatus': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            if (!text) return reply(`❓ Usage: *${config.PREFIX}setstatus I am RIOT MD*`);
            await sock.updateProfileStatus(text);
            await reply(`✅ Status updated: _${text}_`);
            break;
          }

          case 'block': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            const mentioned =
              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length)
              return reply(`❓ Usage: *${config.PREFIX}block @user*`);
            await sock.updateBlockStatus(mentioned[0], 'block');
            await react('🚫');
            await reply(`✅ Blocked +${formatJid(mentioned[0])}`);
            break;
          }

          case 'unblock': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            const mentioned =
              msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length)
              return reply(`❓ Usage: *${config.PREFIX}unblock @user*`);
            await sock.updateBlockStatus(mentioned[0], 'unblock');
            await react('✅');
            await reply(`✅ Unblocked +${formatJid(mentioned[0])}`);
            break;
          }

          case 'restart': {
            if (!isOwnerMsg) return reply('❌ Owner only!');
            await reply('♻️ Restarting RIOT MD...');
            setTimeout(() => process.exit(0), 2000);
            break;
          }

          // ═══════════════ REGISTER FLOW ══════════════════════

          case 'register': {
            if (flows.has(sender))
              return reply('⚠️ You have an active session. Complete it first.');

            const flow = createConversationFlow(
              [
                {
                  prompt:
                    `📝 *RIOT MD Registration*\n\n` +
                    `Step 1/3 — What's your *name*?`,
                  key: 'name',
                  validate: (v) =>
                    v.length >= 2 || '❌ Name must be at least 2 characters.',
                },
                {
                  prompt: `Step 2/3 — What's your *age*?`,
                  key: 'age',
                  validate: (v) =>
                    (!isNaN(v) && Number(v) > 0) || '❌ Enter a valid age.',
                },
                {
                  prompt: `Step 3/3 — What's your *country*?`,
                  key: 'country',
                },
              ],
              async (collected) => {
                await sock.sendMessage(
                  chatId,
                  {
                    text:
                      `✅ *Registration Complete!*\n\n` +
                      `👤 Name: *${collected.name}*\n` +
                      `🎂 Age: *${collected.age}*\n` +
                      `🌍 Country: *${collected.country}*\n\n` +
                      `Welcome to *RIOT MD*, ${collected.name}! 🎉`,
                  },
                  { quoted: msg }
                );
                flows.delete(sender);
              }
            );

            flows.set(sender, flow);
            await reply(flow.currentPrompt());
            break;
          }

          // ═══════════════ DEFAULT ════════════════════════════

          default: {
            await react('❓');
            await reply(
              `❓ Unknown command: *${config.PREFIX}${cmd}*\n\n` +
              `Type *${config.PREFIX}menu* to see all commands.`
            );
          }
        }

      } catch (err) {
        console.error('[RIOT MD Error]', err.message);
      }
    }
  });
}

// ─── Launch ──────────────────────────────────────────────────────
console.log(`
╔══════════════════════════╗
║   🤖   R I O T   M D    ║
║   WhatsApp Bot  v1.0.0  ║
╚══════════════════════════╝
`);

startRiotMD();