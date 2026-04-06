const axios = require('axios');

// Format JID to readable number
const formatJid = (jid) => jid?.replace(/[^0-9]/g, '') || '';

// Get sender display name
const getSenderName = (msg) =>
  msg.pushName || formatJid(msg.key.remoteJid);

// Check if message is from group
const isGroup = (jid) => jid?.endsWith('@g.us');

// Check if user is owner
const isOwner = (jid, ownerNumber) =>
  formatJid(jid) === ownerNumber;

// Get current time greeting
const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
};

// Fetch from API safely
const fetchApi = async (url, params = {}) => {
  try {
    const res = await axios.get(url, { params, timeout: 8000 });
    return res.data;
  } catch {
    return null;
  }
};

// Format bytes to readable
const formatBytes = (bytes) => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
};

// Runtime formatter
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
  formatBytes,
  formatRuntime,
};
