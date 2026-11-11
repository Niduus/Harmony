// Discord markdown to HTML for chat messages and embeds. Everything is escaped first;
// mentions arrive as <@id>, <@&id>, <#id> and are swapped for names Harmony's core sends along.

import { esc, clock } from './util.js';

const CODEBLOCK = /```(?:([A-Za-z0-9_+\-]{1,20})\n)?([\s\S]*?)```/g;

const TOKENS = [
  // \* \_ \. … show the character itself, like Discord (bots escape markdown this way).
  ['escape', /\\([^A-Za-z0-9\s])/g],
  ['code', /`([^`\n]+)`/g],
  ['masked', /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g],
  ['bare', /<(https?:\/\/[^\s>]+)>/g],
  ['spoiler', /\|\|([\s\S]+?)\|\|/g],
  ['bold', /\*\*([\s\S]+?)\*\*(?!\*)/g],
  ['underline', /__([\s\S]+?)__(?!_)/g],
  ['strike', /~~([\s\S]+?)~~/g],
  ['italic', /\*(?!\s)([\s\S]+?)(?<!\s)\*/g],
  ['italic_', /(?<![A-Za-z0-9])_(?!\s)([\s\S]+?)(?<!\s)_(?![A-Za-z0-9])/g],
  ['user', /<@!?(\d+)>/g],
  ['role', /<@&(\d+)>/g],
  ['channel', /<#(\d+)>/g],
  ['emoji', /<(a?):(\w+):(\d+)>/g],
  ['time', /<t:(-?\d+)(?::([tTdDfFR]))?>/g],
  ['everyone', /@(everyone|here)\b/g],
  ['link', /https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/g],
];

const WRAP = { spoiler: ['<span class="spoiler">', '</span>'], bold: ['<strong>', '</strong>'], underline: ['<u>', '</u>'], strike: ['<s>', '</s>'], italic: ['<em>', '</em>'], italic_: ['<em>', '</em>'] };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatTimestamp(seconds, style, now = Date.now() / 1000) {
  if (style === 'R') {
    const delta = seconds - now;
    const span = Math.abs(delta);
    let text = 'a few seconds';
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (span >= size) {
        const count = Math.floor(span / size);
        text = `${count} ${unit}${count === 1 ? '' : 's'}`;
        break;
      }
    }
    return delta > 0 ? `in ${text}` : `${text} ago`;
  }
  const d = new Date(seconds * 1000);
  const pad = n => String(n).padStart(2, '0');
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  switch (style) {
    case 't': return clock(d.getTime());
    case 'T': return `${clock(d.getTime())}:${pad(d.getSeconds())}`;
    case 'd': return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'D': return date;
    case 'F': return `${DAYS[d.getDay()]}, ${date} ${clock(d.getTime())}`;
    default: return `${date} ${clock(d.getTime())}`;
  }
}

function inline(text, mentions, depth = 0) {
  let out = '';
  let position = 0;
  while (position < text.length) {
    let best = null;
    for (const [name, pattern] of TOKENS) {
      pattern.lastIndex = position;
      const match = pattern.exec(text);
      if (match && (!best || match.index < best[1].index)) {
        best = [name, match];
        if (match.index === position) break;
      }
    }
    if (!best) break;
    const [name, match] = best;
    if (match.index > position) out += esc(text.slice(position, match.index));
    const users = mentions.users || {};
    const roles = mentions.roles || {};
    const channels = mentions.channels || {};
    if (WRAP[name]) {
      out += WRAP[name][0] + (depth < 8 ? inline(match[1], mentions, depth + 1) : esc(match[1])) + WRAP[name][1];
    } else if (name === 'escape') {
      out += esc(match[1]);
    } else if (name === 'code') {
      out += `<code>${esc(match[1])}</code>`;
    } else if (name === 'user') {
      out += `<span class="mention" data-user="${esc(match[1])}">@${esc(users[match[1]] || 'unknown-user')}</span>`;
    } else if (name === 'role') {
      const color = (mentions.roleColors || {})[match[1]];
      const tint = /^#[0-9a-f]{6}$/i.test(color || '') ? ` style="color:${color};background:${color}1f"` : '';
      out += `<span class="mention"${tint}>@${esc(roles[match[1]] || 'unknown-role')}</span>`;
    } else if (name === 'channel') {
      out += `<span class="mention" data-channel="${esc(match[1])}">#${esc(channels[match[1]] || 'unknown-channel')}</span>`;
    } else if (name === 'emoji') {
      const url = `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? 'gif' : 'png'}?size=96`;
      out += `<img class="emoji" src="${url}" alt=":${esc(match[2])}:" title=":${esc(match[2])}:" draggable="false">`;
    } else if (name === 'time') {
      const seconds = Number(match[1]);
      out += `<span class="ts" title="${esc(formatTimestamp(seconds, 'F'))}">${esc(formatTimestamp(seconds, match[2]))}</span>`;
    } else if (name === 'everyone') {
      out += `<span class="mention">${esc(match[0])}</span>`;
    } else if (name === 'link') {
      out += `<a data-href="${esc(match[0])}" title="${esc(match[0])}">${esc(match[0])}</a>`;
    } else if (name === 'bare') {
      out += `<a data-href="${esc(match[1])}" title="${esc(match[1])}">${esc(match[1])}</a>`;
    } else if (name === 'masked') {
      out += `<a data-href="${esc(match[2])}" title="${esc(match[2])}">${inline(match[1], mentions, depth + 1)}</a>`;
    }
    position = match.index + match[0].length;
  }
  if (position < text.length) out += esc(text.slice(position));
  return out;
}

function lines(text, mentions) {
  const rows = text.split('\n');
  let out = '';
  for (let index = 0; index < rows.length; index += 1) {
    let line = rows[index];
    if (line.startsWith('>>> ')) {
      out += `<blockquote>${inline(rows.slice(index).join('\n').slice(4), mentions)}</blockquote>`;
      return out;
    }
    let quote = false;
    if (line.startsWith('> ') || line === '>') {
      quote = true;
      line = line.slice(2);
    }
    let html;
    const header = /^(#{1,3}|-#) (.*)$/.exec(line);
    if (header) {
      const tag = header[1] === '-#' ? 'subtext' : `h${header[1].length}`;
      html = tag === 'subtext' ? `<span class="subtext">${inline(header[2], mentions)}</span>` : `<${tag}>${inline(header[2], mentions)}</${tag}>`;
    } else if (/^\s*[-*] /.test(line)) {
      const indent = line.match(/^\s*/)[0].length;
      html = `<span style="padding-left:${8 + indent * 8}px">•&nbsp; ${inline(line.replace(/^\s*[-*] /, ''), mentions)}</span>`;
    } else {
      html = inline(line, mentions);
    }
    out += quote ? `<blockquote>${html}</blockquote>` : html;
    const blockish = quote || (header && header[1] !== '-#');
    if (index < rows.length - 1 && !blockish) out += '\n';
  }
  return out;
}

/** Discord markdown to HTML. */
export function render(content, mentions = {}) {
  const text = String(content ?? '');
  let out = '';
  let position = 0;
  CODEBLOCK.lastIndex = 0;
  for (const match of text.matchAll(CODEBLOCK)) {
    if (match.index > position) out += lines(text.slice(position, match.index).replace(/\n$/, ''), mentions);
    out += `<pre><code>${esc(match[2].replace(/^\n+|\n+$/g, ''))}</code></pre>`;
    position = match.index + match[0].length;
    if (text[position] === '\n') position += 1;
  }
  if (position < text.length) out += lines(text.slice(position), mentions);
  return out;
}

const CUSTOM = /<a?:\w+:\d+>/g;
const PICTO = /\p{Extended_Pictographic}/u;

/** True when a message is only emoji (Discord draws those big). */
export function isJumbo(content) {
  const text = String(content || '').trim();
  if (!text || text.length > 200) return false;
  const customs = text.match(CUSTOM) || [];
  const rest = text.replace(CUSTOM, '').replace(/[\s‍️⃣]/g, '');
  const pictos = [...rest].filter(ch => PICTO.test(ch) || /[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/u.test(ch));
  if (pictos.length !== [...rest].length) return false;
  return customs.length + pictos.length > 0 && customs.length + pictos.length <= 27;
}

/** Plain text (for previews and Copy Text). */
export function plain(content, mentions = {}) {
  const div = document.createElement('div');
  div.innerHTML = render(content, mentions);
  return div.textContent || '';
}
