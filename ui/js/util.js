// Small helpers with no DOM state: formatting, grouping and Discord-style text rules.

export const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const h = (html) => {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
};

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const nonce = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 20; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

const pad = n => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Discord-style timestamp: 'Today at 14:05', 'Yesterday at 14:05', else '11/03/2026 14:05'. */
export function formatWhen(ms, now = Date.now()) {
  if (!ms) return '';
  const time = clock(ms);
  if (sameDay(ms, now)) return `Today at ${time}`;
  if (sameDay(ms, now - 86400000)) return `Yesterday at ${time}`;
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${time}`;
}

export function formatDay(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatFull(ms) {
  const d = new Date(ms);
  return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${clock(ms)}`;
}

export function formatDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  seconds = Math.floor(seconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const mins = Math.floor(seconds / 60) % 60;
  const secs = seconds % 60;
  const hms = `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return days ? `${days}d ${hms}` : hms;
}

export function formatClock(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor(seconds / 60) % 60;
  const secs = seconds % 60;
  return hours ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

export function formatSize(size) {
  let value = Number(size) || 0;
  for (const unit of ['bytes', 'KB', 'MB', 'GB']) {
    if (value < 1024 || unit === 'GB') return unit === 'bytes' ? `${Math.floor(value)} bytes` : `${value.toFixed(1).replace(/\.0$/, '')} ${unit}`;
    value /= 1024;
  }
  return '';
}

export function formatMoney(amount) {
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  return Number.isInteger(value) ? `$${value.toLocaleString('en-US')}` : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What Discord shows for a server with no icon: the first letter of each word, max 3. */
export function initials(name) {
  const words = String(name || '').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  return words.map(w => w[0]).filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('').slice(0, 3).toUpperCase() || '?';
}

/** (headline, detail) for the music card. */
export function describeMusic(music, now = Date.now()) {
  const current = music?.current;
  if (!current) {
    if (music?.connected) return ['In voice, nothing playing', `in ${music.voiceChannel || 'a voice channel'}`];
    return ['Not playing', 'Start a song from Discord with /play.'];
  }
  if (current.idle) return ['Idle music', `in ${music.voiceChannel || 'voice'} · Skip or Stop to leave voice`];
  const parts = [];
  const duration = Number(current.duration) || 0;
  if (music.paused) {
    parts.push(`paused${music.pauseResumeAt ? `, resumes in ${formatClock((music.pauseResumeAt - now) / 1000)}` : ''}`);
  } else if (music.startedAt && duration) {
    parts.push(`${formatClock((now - music.startedAt) / 1000)} / ${formatClock(duration)}`);
  } else if (duration) {
    parts.push(formatClock(duration));
  }
  if (current.requestedByName) parts.push(`asked for by ${current.requestedByName}`);
  if (music.voiceChannel) parts.push(`in ${music.voiceChannel}`);
  if (music.loopMode && music.loopMode !== 'off') parts.push(`loop ${music.loopMode}`);
  return [String(current.title || 'Unknown track'), parts.join('  ·  ')];
}

/** Discord-style grouping: uncategorised channels first, then each category in order. Text and
 *  forums before voice inside a category, and each forum's posts right under it. */
export function groupChannels(channels) {
  const posts = new Map();
  const groups = new Map();
  for (const channel of channels || []) {
    if (channel.kind === 'post') {
      const key = String(channel.parentId || '');
      if (!posts.has(key)) posts.set(key, []);
      posts.get(key).push(channel);
      continue;
    }
    const name = String(channel.category || '');
    const position = name ? Number(channel.categoryPosition ?? -1) : -2;
    if (!groups.has(name)) groups.set(name, { position, items: [] });
    groups.get(name).items.push(channel);
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].position - b[1].position)
    .map(([name, group]) => {
      const listed = [];
      const ordered = [...group.items].sort((a, b) => (a.kind === 'voice' ? 1 : 0) - (b.kind === 'voice' ? 1 : 0));
      for (const channel of ordered) {
        listed.push(channel);
        if (channel.kind === 'forum') listed.push(...(posts.get(String(channel.id)) || []));
      }
      return [name, listed];
    });
}

/** What a feature can post in: text channels, forums (a new post) and forum posts, in sidebar order. */
export function postTargets(channels) {
  const rows = [];
  for (const [, items] of groupChannels(channels)) {
    for (const channel of items) {
      if (channel.kind === 'text') rows.push({ id: channel.id, label: `# ${channel.name}` });
      else if (channel.kind === 'forum') rows.push({ id: channel.id, label: `💬 ${channel.name} (new post)` });
      else if (channel.kind === 'post') rows.push({ id: channel.id, label: `💬 ${channel.parentName || 'forum'} › ${channel.name}` });
    }
  }
  return rows;
}

/** Split pasted Discord IDs (commas, spaces, new lines) into valid IDs and rejected bits. */
export function parseIdList(text) {
  const ids = [];
  const bad = [];
  for (let part of String(text || '').replace(/[,;]/g, ' ').split(/\s+/)) {
    part = part.trim().replace(/^[<@!]+|[>]+$/g, '');
    if (/^\d{10,30}$/.test(part)) {
      if (!ids.includes(part)) ids.push(part);
    } else if (part) {
      bad.push(part);
    }
  }
  return [ids, bad];
}

export const isSnowflake = text => /^\d{10,30}$/.test(String(text || '').trim());

/** The name being typed after an @ right before the cursor ('' just after the @), or null. */
export function mentionQuery(beforeCursor) {
  const at = beforeCursor.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(beforeCursor[at - 1]) && !'([{'.includes(beforeCursor[at - 1])) return null;
  const query = beforeCursor.slice(at + 1);
  if (query.length > 32 || /[\s@<>#:]/.test(query)) return null;
  return query;
}

export function mentionCode(kind, id) {
  if (kind === 'role') return `<@&${id}>`;
  if (kind === 'special') return `@${id}`;
  return `<@${id}>`;
}

/** Swap each picked '@Name' for Discord's mention code, longest names first. */
export function applyMentions(text, picked) {
  for (const name of Object.keys(picked).sort((a, b) => b.length - a.length)) {
    const { kind, id } = picked[name];
    text = text.split(`@${name}`).join(mentionCode(kind, id));
  }
  return text;
}

const ACHIEVEMENT = /achievement unlocked/i;

export function isAchievement(message) {
  if (message.achievement) return true;
  return [message.content || '', ...(message.embeds || [])].some(text => ACHIEVEMENT.test(String(text)));
}

/** The DM list as shown. With achievements hidden, a chat shows its newest other message, and a
 *  chat that is only achievements drops out (unless it is the one open). */
export function visibleConversations(conversations, hideAchievements, openUser = '') {
  if (!hideAchievements) return [...conversations];
  const rows = [];
  for (let entry of conversations) {
    if (ACHIEVEMENT.test(String(entry.lastPreview || ''))) {
      if (!entry.quietPreview) {
        if (entry.userId === openUser) rows.push({ ...entry, lastPreview: '' });
        continue;
      }
      entry = { ...entry, lastPreview: entry.quietPreview, lastAt: entry.quietAt || entry.lastAt };
    }
    rows.push(entry);
  }
  return rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

export function describeDmScan(scan) {
  if (!scan) return '';
  if (scan.running) {
    const total = Number(scan.total) || 0;
    return total ? `Finding older DMs… ${Number(scan.done) || 0} of ${total} members checked` : 'Finding older DMs…';
  }
  if (scan.error) return `Could not finish looking for older DMs: ${scan.error}`;
  if (scan.finishedAt) return 'Everyone in your servers has been checked.';
  return '';
}

export const FEATURE_ICONS = {
  music: '♪', downloads: '⇩', casino: '🎲', levels: '★', achievements: '🏆', memes: '☺', pins: '📌', moderation: '🔒',
  deployments: '⚔', ygo: '🃏', bugs: '🐞', welcome: '👋', news: '📰', shroud: '☾', honeypot: '🍯',
};

export const isImage = att => String(att.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/i.test(String(att.name || ''));
export const isVideo = att => String(att.contentType || '').startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(String(att.name || ''));
export const isAudio = att => String(att.contentType || '').startsWith('audio/') || /\.(mp3|ogg|wav|flac|m4a)$/i.test(String(att.name || ''));

/** Fit (w, h) inside a box, keeping the shape. */
export function fitBox(width, height, maxW, maxH) {
  width = Number(width) || maxW;
  height = Number(height) || Math.round(maxW * 0.5625);
  const scale = Math.min(1, maxW / width, maxH / height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** Ask Discord's media proxy for a smaller copy of a picture. */
export function sizedUrl(url, width, height) {
  if (!url || !url.includes('media.discordapp.net') || /[?&]width=/.test(url)) return url;
  const joiner = url.includes('?') ? '&' : '?';
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  return `${url}${joiner}width=${Math.round(width * ratio)}&height=${Math.round(height * ratio)}`;
}

export function typingText(names) {
  if (names.length === 1) return [`<b>${esc(names[0])}</b> is typing…`];
  if (names.length === 2) return [`<b>${esc(names[0])}</b> and <b>${esc(names[1])}</b> are typing…`];
  if (names.length === 3) return [`<b>${esc(names[0])}</b>, <b>${esc(names[1])}</b> and <b>${esc(names[2])}</b> are typing…`];
  return ['Several people are typing…'];
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
