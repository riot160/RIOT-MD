const axios = require('axios');

const formatJid = (jid) => jid?.replace(/[^0-9]/g, '') || '';

const getSenderName = (msg) =>
  msg.pushName || formatJid(msg.key.remoteJid);

const isGroup = (jid) => jid?.endsWith('@g.us');

const isOwner = (jid, ownerNumber) =>
  formatJid(jid) === ownerNumber;

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning ☀️';
  if (h < 17) return 'Good Afternoon 🌤️';
  return 'Good Evening 🌙';
};

const fetchApi = async (url, params = {}) => {
  try {
    const res = await axios.get(url, { params, timeout: 8000 });
    return res.data;
  } catch {
    return null;
  }
};

const formatRuntime = (seconds) => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
};

module.exports = {
  formatJid,
  getSenderName,
  isGroup,
  isOwner,
  getGreeting,
  fetchApi,
  formatRuntime,
};
