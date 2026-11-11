// Chats the way the Discord client does them (copied from hbv's panel, with Harmony's
// not-yet actions switched off in features.js): the message list, the message box, replies,
// inline edits, reactions, embeds, pictures and videos, the typing line, and pins.
//
// A chat is named by a key: "ch:<channelId>" for a server channel or forum post, "dm:<userId>"
// for a DM. The page that shows a chat hands ChatPane a context:
//   { key, where: {guildId, channelId} | {userId}, name, guildId, plainOnly, intro: {icon, img, title, text}, placeholder, hint }

import { api, get, post } from './bridge.js';
import { icon } from './icons.js';
import { render, isJumbo, plain } from './markdown.js';
import {
  esc, h, clock, sameDay, formatDay, formatWhen, formatFull, formatSize, initials, nonce, fitBox, sizedUrl,
  isImage, isVideo, isAudio, mentionQuery, applyMentions, typingText, isAchievement, fileToBase64, UPLOAD_LIMIT_BYTES, debounce,
} from './util.js';
import { menu, confirm, toast, copy, lightbox, emojiPicker, popover, closeFloat, QUICK_REACTIONS, openUrl } from './ui.js';
import { CAN } from './features.js';

// ================================================================== the store

export class ChatStore {
  constructor() {
    this.chats = new Map();
    this.listeners = new Set();
    this.rev = 0;
  }

  get(key) {
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { key, messages: [], pending: [], more: false, loaded: false, loading: false, error: '', fetchedAt: 0, olderLoading: false };
      this.chats.set(key, chat);
    }
    return chat;
  }

  changed(key) {
    for (const listener of this.listeners) listener(key);
  }

  stamp(message) {
    this.rev += 1;
    message._rev = this.rev;
    return message;
  }

  load(key, messages, more) {
    const chat = this.get(key);
    chat.messages = sortMessages((messages || []).map(m => this.stamp({ ...m })));
    chat.more = Boolean(more);
    chat.loaded = true;
    chat.error = '';
    chat.fetchedAt = Date.now();
    this.dropResolvedPending(chat);
    this.changed(key);
  }

  prepend(key, older, more) {
    const chat = this.get(key);
    const ids = new Set(chat.messages.map(m => m.id));
    chat.messages = sortMessages([...older.filter(m => !ids.has(m.id)).map(m => this.stamp({ ...m })), ...chat.messages]);
    chat.more = Boolean(more);
    this.changed(key);
  }

  upsert(key, message) {
    const chat = this.get(key);
    const index = chat.messages.findIndex(m => m.id === message.id);
    const stamped = this.stamp({ ...(index >= 0 ? chat.messages[index] : {}), ...message });
    if (index >= 0) chat.messages[index] = stamped;
    else chat.messages = sortMessages([...chat.messages, stamped]);
    if (message.nonce) chat.pending = chat.pending.filter(p => p.nonce !== message.nonce);
    this.changed(key);
  }

  patch(key, id, changes) {
    const chat = this.get(key);
    const index = chat.messages.findIndex(m => m.id === id);
    if (index < 0) return null;
    const before = chat.messages[index];
    chat.messages[index] = this.stamp({ ...before, ...changes });
    this.changed(key);
    return before;
  }

  restore(key, message) {
    const chat = this.get(key);
    const index = chat.messages.findIndex(m => m.id === message.id);
    if (index >= 0) chat.messages[index] = this.stamp({ ...message });
    else chat.messages = sortMessages([...chat.messages, this.stamp({ ...message })]);
    this.changed(key);
  }

  remove(key, id) {
    const chat = this.get(key);
    const before = chat.messages.find(m => m.id === id) || null;
    chat.messages = chat.messages.filter(m => m.id !== id);
    this.changed(key);
    return before;
  }

  addPending(key, pending) {
    const chat = this.get(key);
    chat.pending.push(this.stamp(pending));
    this.changed(key);
  }

  resolvePending(key, nonceValue, sent) {
    const chat = this.get(key);
    chat.pending = chat.pending.filter(p => p.nonce !== nonceValue);
    if (sent) this.upsert(key, { ...sent, nonce: nonceValue });
    else this.changed(key);
  }

  failPending(key, nonceValue, error) {
    const chat = this.get(key);
    const pending = chat.pending.find(p => p.nonce === nonceValue);
    if (pending) {
      pending.error = error;
      this.stamp(pending);
    }
    this.changed(key);
  }

  discardPending(key, nonceValue) {
    const chat = this.get(key);
    chat.pending = chat.pending.filter(p => p.nonce !== nonceValue);
    this.changed(key);
  }

  dropResolvedPending(chat) {
    const nonces = new Set(chat.messages.map(m => m.nonce).filter(Boolean));
    chat.pending = chat.pending.filter(p => !nonces.has(p.nonce));
  }

  forget(key) {
    this.chats.delete(key);
  }

  invalidateAll() {
    for (const chat of this.chats.values()) chat.fetchedAt = 0;
  }
}

function sortMessages(messages) {
  return messages.sort((a, b) => (a.createdAt - b.createdAt) || (BigInt(a.id || 0) < BigInt(b.id || 0) ? -1 : 1));
}

// ================================================================== typing

export class Typing {
  constructor(onChange) {
    this.map = new Map();
    this.onChange = onChange;
    this.timer = 0;
  }

  add(key, authorId, name) {
    if (!this.map.has(key)) this.map.set(key, new Map());
    this.map.get(key).set(authorId, { name, until: Date.now() + 10000 });
    this.onChange(key);
    this.schedule();
  }

  stop(key, authorId) {
    if (this.map.get(key)?.delete(authorId)) this.onChange(key);
  }

  names(key) {
    const now = Date.now();
    const entries = this.map.get(key);
    if (!entries) return [];
    for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
    return [...entries.values()].map(e => e.name);
  }

  schedule() {
    clearTimeout(this.timer);
    let next = Infinity;
    for (const entries of this.map.values()) for (const entry of entries.values()) next = Math.min(next, entry.until);
    if (next < Infinity) {
      this.timer = setTimeout(() => {
        for (const key of this.map.keys()) this.onChange(key);
        this.schedule();
      }, Math.max(200, next - Date.now() + 50));
    }
  }
}

// ================================================================== drawing one message

function avatarHtml(url, name, cls = '') {
  return url ? `<img src="${esc(url)}" alt="" loading="lazy" draggable="false" class="${cls}">` : esc(initials(name).slice(0, 2));
}

// When a picture or GIF clip fails to load, show the next address (Discord's copy) instead.
// Harmony's window blocks inline scripts (a message can never run code), so a picture that
// fails to load falls back from this one listener instead of an onerror attribute.
document.addEventListener('error', event => {
  const el = event.target;
  if (el?.tagName === 'IMG' && el.dataset.fb) {
    const next = el.dataset.fb;
    el.dataset.fb = '';
    el.src = next;
  } else if (el?.tagName === 'VIDEO' && el.dataset.clipFb) {
    const poster = el.getAttribute('poster');
    if (poster) {
      const img = document.createElement('img');
      img.src = poster;
      img.alt = '';
      el.replaceWith(img);
    }
  }
}, true);

function mediaHtml({ src, width, height, maxW = 400, maxH = 300, open, video = false, spoiler = false, gifv = false, poster = '', fallback = '' }) {
  const [w, hgt] = fitBox(width, height, maxW, maxH);
  const style = `width:${w}px;height:${hgt}px`;
  if (gifv) {
    // A GIF site's clip: plays on a loop with no sound, like Discord. If it will not play,
    // the still picture shows instead.
    return `<div class="media${spoiler ? ' spoiler' : ''}" style="${style}" data-open="${esc(open || src)}" data-video="1"><video src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ''} autoplay loop muted playsinline preload="auto" data-clip-fb="1"></video></div>`;
  }
  if (video) {
    return `<video class="player" src="${esc(src)}" controls preload="metadata" style="${style}" ${poster ? `poster="${esc(poster)}"` : ''}></video>`;
  }
  const fb = fallback && fallback !== src ? ` data-fb="${esc(fallback)}"` : '';
  return `<div class="media${spoiler ? ' spoiler' : ''}" style="${style}" data-open="${esc(open || src)}"><img src="${esc(sizedUrl(src, w, hgt))}"${fb} alt="" loading="lazy" decoding="async" draggable="false"></div>`;
}

function attachmentHtml(att, pending = false) {
  if (!pending && isImage(att) && att.url) {
    const gif = /\.gif($|\?)/i.test(att.name || '') || /image\/gif/i.test(att.contentType || '');
    const src = gif ? att.url : (att.proxyUrl || att.url);
    return mediaHtml({ src, width: att.width, height: att.height, open: att.url, spoiler: att.spoiler });
  }
  if (!pending && isVideo(att) && att.url) {
    return mediaHtml({ src: att.url, width: att.width || 400, height: att.height || 225, video: true });
  }
  if (!pending && isAudio(att) && att.url) {
    return `<div class="att-file"><span class="fi">${icon('file', 's24')}</span><div class="fn"><a data-href="${esc(att.url)}">${esc(att.name)}</a><audio src="${esc(att.url)}" controls preload="none" style="width:100%;margin-top:6px;height:32px"></audio></div></div>`;
  }
  return `<div class="att-file"><span class="fi">${icon('file', 's24')}</span><div class="fn">${att.url ? `<a data-href="${esc(att.url)}">${esc(att.name)}</a>` : esc(att.name)}<div class="fs">${esc(formatSize(att.size))}</div></div>${att.url ? `<button class="icon-btn" data-href="${esc(att.url)}" data-tip="Download">${icon('download')}</button>` : ''}</div>`;
}

function isGifSite(card) {
  return /tenor\.com|giphy\.com|klipy\.com|imgur\.com/i.test(`${card.url} ${card.provider} ${card.video}`);
}

const DIRECT_VIDEO = /\.(mp4|webm|mov|m4v)(\?|$)/i;

/** A video file the panel can play itself (not a site's player page). */
const PAGE_PLAYERS = /youtube(-nocookie)?\.com|youtu\.be|vimeo\.com|twitch\.tv|streamable\.com|dailymotion\.com|tiktok\.com|spotify\.com|soundcloud\.com|reddit\.com/i;

function directVideo(card) {
  for (const url of [card.videoProxy, card.video]) {
    if (url && (DIRECT_VIDEO.test(url) || /video\.twimg\.com|(cdn|media)\.discordapp\.(com|net)\/attachments/i.test(url))) return url;
  }
  // Link fixers (FixupX, vxTwitter, kkinstagram…) hand Discord a video file under their own
  // address without a .mp4 ending; anything that is not a site's player page is a file.
  for (const url of [card.videoProxy, card.video]) {
    if (url && /^https?:/i.test(url) && !PAGE_PLAYERS.test(url)) return url;
  }
  return '';
}

/** A site player that can play inside the chat (YouTube, Vimeo, Streamable). */
function playerUrl(card) {
  const text = `${card.video || ''} ${card.url || ''}`;
  let m = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^ ]*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i.exec(text);
  if (m) {
    const start = /[?&]t=(\d+)/.exec(card.url || '');
    return `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0${start ? `&start=${start[1]}` : ''}`;
  }
  m = /(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i.exec(text);
  if (m) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`;
  m = /streamable\.com\/(?:[eo]\/)?([A-Za-z0-9]+)/i.exec(text);
  if (m) return `https://streamable.com/e/${m[1]}?autoplay=1`;
  return '';
}

function playOverlay() {
  return `<span class="play-badge">${icon('play', 's24')}</span>`;
}

/** The video in an embed: our own player for a video file, the site's player for
 *  YouTube and friends (after a click, like Discord), or a poster that opens the link. */
function embedVideoHtml(card) {
  const poster = card.thumbnail || card.image;
  const width = card.videoWidth || poster?.width || 400;
  const height = card.videoHeight || poster?.height || 225;
  const direct = directVideo(card);
  if (direct) return mediaHtml({ src: direct, width, height, video: true, poster: poster?.url });
  const [w, hgt] = fitBox(width, height, 400, 300);
  const player = playerUrl(card);
  const look = poster ? `<img src="${esc(poster.url)}" alt="" loading="lazy" decoding="async" draggable="false">` : '';
  if (player) return `<div class="media video-poster" style="width:${w}px;height:${hgt}px" data-embed="${esc(player)}">${look}${playOverlay()}</div>`;
  return `<div class="media video-poster" style="width:${w}px;height:${hgt}px" data-href="${esc(card.url || card.video)}">${look}${playOverlay()}</div>`;
}

/** GIFs (Tenor, Giphy, Klipy…) and plain picture links: Discord shows just the media. */
function isMediaOnly(card) {
  const picture = card.image || card.thumbnail;
  return card.type === 'gifv' || (card.type === 'image' && Boolean(picture)) || (card.type === 'video' && Boolean(card.video) && isGifSite(card));
}

function embedHtml(card, mentions) {
  const picture = card.image || card.thumbnail;
  if (isMediaOnly(card)) {
    const clip = directVideo(card);
    if (clip) {
      return `<div class="embed media-only">${mediaHtml({ src: clip, width: card.videoWidth || picture?.width, height: card.videoHeight || picture?.height, gifv: true, poster: picture?.url, open: card.url })}</div>`;
    }
    if (picture) {
      // The site's own file first: Discord's copy of a GIF or animated WebP is often a still.
      const first = picture.original || picture.url;
      return `<div class="embed media-only">${mediaHtml({ src: first, fallback: picture.url, width: picture.width, height: picture.height, open: card.url || picture.original || picture.url })}</div>`;
    }
  }
  const hasVideo = Boolean(card.video);
  const color = card.color && card.color !== '#000000' ? card.color : '#1e1f22';
  let main = '';
  if (card.provider) main += `<div class="e-provider">${esc(card.provider)}</div>`;
  if (card.author) {
    const iconHtml = card.authorIcon ? `<img class="e-icon" src="${esc(card.authorIcon)}" alt="" loading="lazy" draggable="false">` : '';
    const name = card.authorUrl ? `<a data-href="${esc(card.authorUrl)}">${esc(card.author)}</a>` : esc(card.author);
    main += `<div class="e-author">${iconHtml}<span>${name}</span></div>`;
  }
  if (card.title) main += `<div class="e-title md">${card.url ? `<a data-href="${esc(card.url)}">${render(card.title, mentions)}</a>` : render(card.title, mentions)}</div>`;
  if (card.description) main += `<div class="e-desc md">${render(card.description, mentions)}</div>`;
  if (card.fields?.length) {
    main += `<div class="e-fields">${card.fields.map(f => `<div class="e-field${f.inline ? ' inline' : ''}"><div class="fn md">${render(f.name, mentions)}</div><div class="fv md">${render(f.value, mentions)}</div></div>`).join('')}</div>`;
  }
  const thumb = card.thumbnail && !hasVideo && !card.image;
  let html = `<div class="embed${thumb ? ' has-thumb' : ''}" style="border-left-color:${esc(color)}">`;
  if (main) html += `<div class="e-main">${main}</div>`;
  if (thumb) {
    html += `<div class="e-thumb">${mediaHtml({ src: card.thumbnail.url, width: card.thumbnail.width, height: card.thumbnail.height, maxW: 80, maxH: 80, open: card.thumbnail.original || card.thumbnail.url })}</div>`;
  }
  if (hasVideo) {
    html += `<div class="e-image">${embedVideoHtml(card)}</div>`;
  } else if (card.image) {
    html += `<div class="e-image">${mediaHtml({ src: card.image.url, width: card.image.width, height: card.image.height, open: card.image.original || card.image.url })}</div>`;
  }
  if (card.footer || card.timestamp) {
    const iconHtml = card.footerIcon ? `<img class="e-icon small" src="${esc(card.footerIcon)}" alt="" loading="lazy" draggable="false">` : '';
    html += `<div class="e-footer">${iconHtml}<span>${esc(card.footer || '')}${card.footer && card.timestamp ? ' • ' : ''}${card.timestamp ? esc(formatWhen(card.timestamp)) : ''}</span></div>`;
  }
  return `${html}</div>`;
}

function reactionsHtml(message) {
  const reactions = message.reactions || [];
  if (!reactions.length) return '';
  const add = CAN.react ? `<div class="reaction add-react" data-act="react" data-tip="Add Reaction">${icon('smilePlus', 's16')}</div>` : '';
  return `<div class="reactions">${reactions.map(r => `<div class="reaction${r.me ? ' me' : ''}" data-react="${esc(r.key)}" data-tip="${esc(r.id ? `:${r.emoji}:` : r.emoji)}">${r.url ? `<img src="${esc(r.url)}" alt="">` : `<span>${esc(r.emoji)}</span>`}<span>${r.count}</span></div>`).join('')}${add}</div>`;
}

const HEX = /^#[0-9a-f]{6}$/i;

// A name drawn the way Discord draws it: the top coloured role's colour, or its gradient
// (holographic when the role has three colours), then the server tag and the role icon.
// Nitro display name fonts, by Discord's font id, drawn with the same (or the closest) free
// Google Fonts family. Each family loads the first time a name needs it.
const NAME_FONTS = {
  1: 'Bangers', 2: 'BioRhyme', 3: 'Cherry Bomb One', 4: 'Chicle', 6: 'MuseoModerno', 7: 'Pirata One',
  8: 'Pixelify Sans', 10: 'Grenze Gotisch', 12: 'Zilla Slab', 13: 'Playpen Sans', 14: 'Orbitron', 15: 'New Rocker', 16: 'Kalam',
};
const loadedFonts = new Set();
function nameFont(id) {
  const family = NAME_FONTS[id];
  if (!family) return '';
  if (!loadedFonts.has(family)) {
    loadedFonts.add(family);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600&display=swap`;
    document.head.appendChild(link);
  }
  return `font-family:'${family}',var(--font);`;
}

// Nitro display name effects: 1 solid, 2 gradient, 3 neon, 4 toon, 5 pop, 6 glow, 7 prism, 8 gummy.
function nameEffect(effect, colors) {
  const c = colors.filter(x => HEX.test(x));
  if (!c.length) return null;
  if ([2, 6, 7, 8].includes(effect) && c.length > 1) {
    return { klass: effect === 7 ? ' grad prism' : ' grad', css: `--g:linear-gradient(90deg,${[...c, c[0]].join(',')});color:${c[0]};` };
  }
  const first = c[0];
  if (effect === 3) return { klass: ' neon', css: `color:${first};text-shadow:0 0 3px ${first}cc,0 0 8px ${first}99;` };
  if (effect === 4) return { klass: ' toon', css: `color:${first};` };
  if (effect === 5) return { klass: '', css: `color:${first};text-shadow:2px 2px 0 ${first}66;` };
  return { klass: '', css: `color:${first};` };
}

export function nameHtml(name, style, { cls = '', attrs = '', prefix = '', extras = true } = {}) {
  const s = style || {};
  let css = '';
  let klass = cls;
  const stops = (s.gradient || []).filter(c => HEX.test(c));
  const custom = s.effect ? nameEffect(s.effect, s.nameColors || []) : null;
  if (custom) {
    klass += custom.klass;
    css = custom.css;
  } else if (stops.length > 1) {
    klass += s.holo ? ' grad holo' : ' grad';
    css = `--g:linear-gradient(90deg,${[...stops, stops[0]].join(',')});color:${stops[0]}`;
  } else if (HEX.test(s.color || '')) {
    css = `color:${s.color}`;
  }
  if (s.font) css = nameFont(s.font) + css;
  let html = `<span class="${klass.trim()}"${css ? ` style="${css}"` : ''}${attrs}>${prefix}${esc(name)}</span>`;
  if (!extras) return html;
  if (s.tag) {
    html += `<span class="gtag" title="Server tag">${s.tagBadge ? `<img src="${esc(s.tagBadge)}" alt="" draggable="false">` : ''}${esc(s.tag)}</span>`;
  }
  if (s.roleIcon) html += `<img class="role-ico" src="${esc(s.roleIcon)}" alt="" title="${esc(s.roleName || '')}" draggable="false">`;
  else if (s.roleEmoji) html += `<span class="role-ico emo" title="${esc(s.roleName || '')}">${esc(s.roleEmoji)}</span>`;
  return html;
}

function replyLine(message) {
  if (message.interaction) {
    return `<div class="reply-line"><span class="ra">${esc(message.interaction.userName)}</span><span>used</span><span class="mention" style="color:var(--blue)">/${esc(message.interaction.command)}</span></div>`;
  }
  const reply = message.reply;
  if (!reply && !message.replyTo) return '';
  if (!reply || reply.missing) return `<div class="reply-line" data-jump="${esc(message.replyTo || reply?.id || '')}"><span class="rt"><i>Original message was deleted</i></span></div>`;
  const text = reply.content ? plain(reply.content, reply.mentions || {}).replace(/\s+/g, ' ') : (reply.attachment ? 'Click to see attachment' : '');
  return `<div class="reply-line" data-jump="${esc(reply.id)}"><span class="avatar s16">${avatarHtml(reply.authorAvatar, reply.authorName)}</span>${nameHtml(reply.authorName, reply.authorStyle, { cls: 'ra', prefix: '@' })}<span class="rt">${esc(text)}</span></div>`;
}

function bodyHtml(message, hideEmbedsText) {
  let html = '';
  let content = String(message.content || '');
  // A message that is only the link to a GIF or picture shows just the media, like Discord.
  const cardsHere = message.embedCards || [];
  if (cardsHere.length && /^<?https?:\/\/\S+>?$/.test(content.trim()) && cardsHere.every(isMediaOnly)) content = '';
  if (content) {
    html += `<div class="body md${isJumbo(content) ? ' jumbo' : ''}">${render(content, message.mentions || {})}${message.edited ? '<span class="edited" title="Edited">(edited)</span>' : ''}</div>`;
  } else if (message.edited && !(message.embedCards || []).length) {
    html += '<div class="body"><span class="edited">(edited)</span></div>';
  }
  const atts = message.attachments || [];
  const stickers = message.stickers || [];
  if (atts.length || stickers.length) {
    html += `<div class="att">${atts.map(a => attachmentHtml(a, message._pending)).join('')}${stickers.map(s => (s.url ? `<img class="sticker" src="${esc(s.url)}" alt="${esc(s.name)}" title="${esc(s.name)}">` : `<div class="att-file">${esc(s.name)} (sticker)</div>`)).join('')}</div>`;
  }
  const cards = message.embedCards;
  if (cards?.length) {
    html += cards.map(card => embedHtml(card, message.mentions || {})).join('');
    if (!content && message.edited) html += '<span class="edited">(edited)</span>';
  } else if (!hideEmbedsText && (message.embeds || []).length) {
    html += (message.embeds || []).map(text => `<div class="embed"><div class="e-main"><div class="e-desc md">${render(text, message.mentions || {})}</div></div></div>`).join('');
  }
  html += reactionsHtml(message);
  return html;
}

function hoverBar(message, ctx) {
  if (message._pending || message.type === 'system') return '';
  let html = '<div class="hoverbar">';
  if (CAN.react) {
    for (const emoji of QUICK_REACTIONS.slice(0, 3)) html += `<button data-quick="${emoji}" data-tip="React with ${emoji}">${emoji}</button>`;
    html += `<button data-act="react" data-tip="Add Reaction">${icon('smilePlus')}</button>`;
  }
  if (CAN.edit && message.canEdit) html += `<button data-act="edit" data-tip="Edit">${icon('edit')}</button>`;
  if (CAN.reply) html += `<button data-act="reply" data-tip="Reply">${icon('reply')}</button>`;
  html += `<button data-act="more" data-tip="More">${icon('more')}</button>`;
  return `${html}</div>`;
}

function messageHtml(message, grouped, ctx, editing) {
  const cls = ['msg'];
  if (!grouped) cls.push('head');
  if (message.mentionsBot) cls.push('mentioned');
  if (message._pending) cls.push('pending');
  if (message.error) cls.push('failed');
  if (editing) cls.push('editing');
  if (message.type === 'system') {
    return `<div class="${cls.join(' ')} head" data-id="${esc(message.id)}"><div class="sys">${icon('join', 's18')}<span>${esc(message.system)}</span><span class="time" title="${esc(formatFull(message.createdAt))}">${esc(formatWhen(message.createdAt))}</span></div></div>`;
  }
  const me = message.fromBot;
  let html = `<div class="${cls.join(' ')}" data-id="${esc(message.id)}">`;
  html += hoverBar(message, ctx);
  if (!grouped) {
    html += replyLine(message);
    html += `<div class="av" data-user="${esc(message.authorId)}">${avatarHtml(message.authorAvatar, message.authorName)}</div>`;
    html += `<div class="hdr">${nameHtml(message.authorName, message.authorStyle, { cls: `author${me && !message.authorStyle?.color ? ' me' : ''}`, attrs: ` data-user="${esc(message.authorId)}"` })}${message.authorBot ? '<span class="tag-bot">bot</span>' : ''}<span class="time" title="${esc(formatFull(message.createdAt))}">${esc(formatWhen(message.createdAt))}</span></div>`;
  } else {
    html += `<span class="side-time" title="${esc(formatFull(message.createdAt))}">${esc(clock(message.createdAt))}</span>`;
  }
  if (editing) {
    html += `<div class="edit-box"><textarea rows="1">${esc(message.editText || message.content || '')}</textarea><div class="edit-hint">escape to <a data-act="cancel-edit">cancel</a> • enter to <a data-act="save-edit">save</a></div></div>`;
    const atts = (message.attachments || []).map(a => attachmentHtml(a)).join('');
    if (atts) html += `<div class="att">${atts}</div>`;
  } else {
    html += bodyHtml(message, Boolean(message.embedCards?.length));
  }
  if (message.error) html += `<div class="note err" style="font-size:12px">${esc(message.error)} <a data-act="retry">Try again</a> · <a data-act="discard">Dismiss</a></div>`;
  return `${html}</div>`;
}

function groups(previous, message) {
  if (!previous || previous.type === 'system' || message.type === 'system') return false;
  if (message.replyTo || message.reply || message.interaction) return false;
  if (previous.authorId !== message.authorId || previous.authorName !== message.authorName) return false;
  if (!sameDay(previous.createdAt, message.createdAt)) return false;
  return message.createdAt - previous.createdAt < 7 * 60 * 1000;
}

// ================================================================== the pane

export class ChatPane {
  constructor(app) {
    this.app = app;
    this.store = app.chats;
    this.ctx = null;
    this.views = new Map();
    this.drafts = new Map();
    this.replying = new Map();
    this.files = new Map();
    this.picked = new Map();
    this.editing = null;
    this.style = 'plain';
    this.replyPing = true;
    this.typingSent = 0;
    this.auto = null;
    this.root = h(`<div class="chat">
      <div class="scroller-host" style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative"></div>
      <div class="composer">
        <div class="box">
          <div class="bar" hidden></div>
          <div class="tray" hidden></div>
          <div class="inner">
            <button class="icon-btn attach" data-tip="Upload a File">${icon('plusCircle', 's24')}</button>
            <textarea rows="1" spellcheck="true"></textarea>
            <div class="tools">
              <div class="style-toggle" hidden><button data-style="plain" data-tip="Plain message">Plain</button><button data-style="embed" data-tip="Coloured box (embed)">Box</button></div>
              <button class="icon-btn emoji" data-tip="Select emoji" data-keep-float>${icon('smile', 's24')}</button>
              <button class="icon-btn send" data-tip="Send">${icon('send', 's24')}</button>
            </div>
          </div>
        </div>
        <div class="under"></div>
        <input type="file" multiple hidden>
      </div>
    </div>`);
    this.host = this.root.querySelector('.scroller-host');
    this.composer = this.root.querySelector('.composer');
    this.box = this.root.querySelector('textarea');
    this.bar = this.root.querySelector('.bar');
    this.tray = this.root.querySelector('.tray');
    this.under = this.root.querySelector('.under');
    this.fileInput = this.root.querySelector('input[type=file]');
    this.styleToggle = this.root.querySelector('.style-toggle');
    this.bindComposer();
    this.bindDrop();
    this.store.listeners.add(key => this.onStoreChange(key));
  }

  // ---------------------------------------------------------------- opening a chat

  open(ctx) {
    const same = this.ctx?.key === ctx.key;
    if (this.ctx && !same) this.saveDraft();
    if (this.editing && this.editing.key !== ctx.key) this.editing = null;
    this.ctx = ctx;
    this.styleToggle.hidden = Boolean(ctx.plainOnly);
    this.box.placeholder = ctx.placeholder || `Message ${ctx.name}`;
    if (!same) {
      this.box.value = this.drafts.get(ctx.key) || '';
      this.closeAuto();
      this.autoGrow();
      this.renderBar();
      this.renderTray();
    }
    const view = this.view(ctx.key);
    if (this.host.firstElementChild !== view.scroller) {
      this.host.replaceChildren(view.scroller, view.jump);
    }
    this.draw(ctx.key);
    this.renderUnder();
    if (view.stick) view.scroller.scrollTop = view.scroller.scrollHeight;
    return view;
  }

  focus() {
    if (!this.editing) this.box.focus();
  }

  saveDraft() {
    if (!this.ctx) return;
    const text = this.box.value;
    if (text) this.drafts.set(this.ctx.key, text);
    else this.drafts.delete(this.ctx.key);
  }

  view(key) {
    let view = this.views.get(key);
    if (view) {
      // Most recently used last, so the oldest views are dropped first.
      this.views.delete(key);
      this.views.set(key, view);
      return view;
    }
    const scroller = h('<div class="scroller selectable-host"><div class="messages"></div></div>');
    const jump = h(`<div class="jump" hidden><span>You're viewing older messages</span><span class="r">Jump To Present ${icon('arrowDown', 's16')}</span></div>`);
    view = { key, scroller, list: scroller.firstElementChild, jump, nodes: new Map(), stick: true, order: [] };
    jump.onclick = () => {
      view.stick = true;
      scroller.scrollTop = scroller.scrollHeight;
      jump.hidden = true;
    };
    scroller.addEventListener('scroll', () => this.onScroll(view), { passive: true });
    new ResizeObserver(() => {
      if (view.stick) scroller.scrollTop = scroller.scrollHeight;
    }).observe(view.list);
    this.bindList(view);
    this.views.set(key, view);
    while (this.views.size > 24) {
      const [oldKey, old] = this.views.entries().next().value;
      if (oldKey === this.ctx?.key) break;
      old.scroller.remove();
      this.views.delete(oldKey);
    }
    return view;
  }

  onScroll(view) {
    const el = view.scroller;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    view.stick = distance < 40;
    view.jump.hidden = distance < 800;
    if (el.scrollTop < 400 && view.key === this.ctx?.key) this.loadOlder();
  }

  onStoreChange(key) {
    if (this.ctx?.key === key) {
      this.draw(key);
    } else if (this.views.has(key)) {
      // Drawn when it is opened again.
      this.views.get(key).dirty = true;
    }
  }

  // ---------------------------------------------------------------- drawing

  items(key) {
    const chat = this.store.get(key);
    const ctx = this.ctx;
    const hideAch = ctx?.hideAchievements;
    const messages = hideAch ? chat.messages.filter(m => !isAchievement(m)) : chat.messages;
    const bot = this.app.botAuthor();
    const pending = chat.pending.map(p => ({
      id: `pending:${p.nonce}`, _pending: true, _rev: p._rev, nonce: p.nonce, fromBot: true, authorId: bot.id, authorName: bot.name, authorAvatar: bot.avatar, authorBot: false,
      content: p.shown, createdAt: p.createdAt, attachments: p.attachments, reply: p.reply, replyTo: p.reply?.id || '', error: p.error || '', mentions: {},
    }));
    const all = [...messages, ...pending];
    const out = [];
    let previous = null;
    for (const message of all) {
      if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
        out.push({ id: `day:${formatDay(message.createdAt)}`, sig: 'day', html: () => `<div class="day"><span>${esc(formatDay(message.createdAt))}</span></div>` });
      }
      const grouped = groups(previous, message);
      const editing = this.editing && this.editing.key === key && this.editing.id === message.id;
      out.push({ id: message.id, message, sig: `${message._rev}|${grouped ? 1 : 0}|${editing ? 1 : 0}|${message.error || ''}`, html: () => messageHtml(message, grouped, ctx, editing) });
      previous = message;
    }
    return { chat, out };
  }

  draw(key) {
    const view = this.view(key);
    view.dirty = false;
    const { chat, out } = this.items(key);
    const list = view.list;
    const scroller = view.scroller;
    // Header at the top: the start of the chat, or a "loading older" line.
    const top = chat.loaded && !chat.more ? `start:${this.ctx?.key}` : (chat.olderLoading ? 'older:loading' : (chat.loaded ? 'older:more' : 'older:wait'));
    const headSig = `${top}|${this.ctx?.intro?.title || ''}|${chat.error}|${chat.loading}`;
    const wanted = [{ id: '__head', sig: headSig, html: () => this.headHtml(chat) }, ...out];
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    const firstOld = view.order.find(id => !id.startsWith('__') && !id.startsWith('day:'));
    const seen = new Set();
    let cursor = list.firstElementChild;
    for (const item of wanted) {
      seen.add(item.id);
      let node = view.nodes.get(item.id);
      if (!node || node.sig !== item.sig) {
        const el = h(item.html());
        if (node) {
          if (node.el === cursor) cursor = el;
          node.el.replaceWith(el);
        }
        node = { el, sig: item.sig };
        view.nodes.set(item.id, node);
      }
      if (node.el === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(node.el, cursor);
    }
    for (const [id, node] of view.nodes) {
      if (!seen.has(id)) {
        node.el.remove();
        view.nodes.delete(id);
      }
    }
    view.order = wanted.map(item => item.id);
    if (view.stick) {
      scroller.scrollTop = scroller.scrollHeight;
    } else if (firstOld && view.order.indexOf(firstOld) > 2) {
      // Older messages came in above: keep what was on screen where it was.
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    }
    if (this.editing && this.editing.key === key) {
      const area = view.nodes.get(this.editing.id)?.el.querySelector('.edit-box textarea');
      if (area && document.activeElement !== area) {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
        grow(area);
      }
    }
  }

  headHtml(chat) {
    const intro = this.ctx?.intro || {};
    if (chat.error && !chat.messages.length) {
      return `<div class="chat-start"><div class="big-ico">${icon('close')}</div><h3>Can't show this chat</h3><p>${esc(chat.error)}</p></div>`;
    }
    if (!chat.loaded) return `<div class="older" style="margin-top:auto">${chat.loading ? 'Loading messages…' : ''}</div>`;
    if (chat.more) return `<div class="older" style="margin-top:auto">${chat.olderLoading ? 'Loading older messages…' : ''}</div><div style="height:${chat.olderLoading ? 0 : 1}px"></div>`;
    return `<div class="chat-start"><div class="big-ico">${intro.img ? `<img src="${esc(intro.img)}" alt="">` : icon(intro.icon || 'hash')}</div><h3>${esc(intro.title || '')}</h3><p>${esc(intro.text || '')}</p></div>`;
  }

  // ---------------------------------------------------------------- loading

  async load(ctx, { force = false, quiet = false } = {}) {
    const chat = this.store.get(ctx.key);
    if (chat.loading) return;
    if (chat.loaded && !force && Date.now() - chat.fetchedAt < 5 * 60 * 1000 && this.app.live) return;
    chat.loading = true;
    if (!chat.loaded && !quiet) this.store.changed(ctx.key);
    const where = ctx.where;
    const result = where.userId ? await get('/api/dm', { userId: where.userId }) : await get('/api/channel/messages', { guildId: where.guildId, channelId: where.channelId });
    chat.loading = false;
    if (result.ok) {
      const info = this.store.get(ctx.key);
      if (result.data.channelId) info.channelId = result.data.channelId;
      if (result.data.user) info.user = result.data.user;
      this.store.load(ctx.key, result.data.messages || [], result.data.more);
      if (where.userId) this.app.onDmRead?.(where.userId, info.user);
    } else {
      chat.error = result.error;
      chat.fetchedAt = Date.now();
      this.store.changed(ctx.key);
    }
  }

  async loadOlder() {
    const ctx = this.ctx;
    if (!ctx) return;
    const chat = this.store.get(ctx.key);
    if (!chat.loaded || !chat.more || chat.olderLoading || !chat.messages.length) return;
    chat.olderLoading = true;
    this.store.changed(ctx.key);
    const before = chat.messages[0].id;
    const where = ctx.where;
    const result = where.userId ? await get('/api/dm', { userId: where.userId, before }) : await get('/api/channel/messages', { guildId: where.guildId, channelId: where.channelId, before });
    chat.olderLoading = false;
    if (result.ok) {
      this.view(ctx.key).stick = false;
      this.store.prepend(ctx.key, result.data.messages || [], result.data.more);
    } else {
      chat.more = false;
      this.store.changed(ctx.key);
      toast(result.error, 'err');
    }
  }

  // ---------------------------------------------------------------- events in the list

  message(id) {
    if (!this.ctx) return null;
    return this.store.get(this.ctx.key).messages.find(m => m.id === id) || null;
  }

  bindList(view) {
    const list = view.list;
    list.addEventListener('click', event => {
      const target = event.target;
      const row = target.closest('.msg');
      const id = row?.dataset.id || '';
      const quick = target.closest('[data-quick]');
      if (quick && CAN.react) return this.react(id, quick.dataset.quick);
      const reaction = target.closest('[data-react]');
      if (reaction && CAN.react) return this.react(id, reaction.dataset.react);
      const act = target.closest('[data-act]');
      if (act) {
        const name = act.dataset.act;
        if (name === 'react' && CAN.react) return this.pickReaction(id, act);
        if (name === 'edit' && CAN.edit) return this.startEdit(id);
        if (name === 'reply' && CAN.reply) return this.startReply(id);
        if (name === 'more') return this.openMenu(id, { anchor: act });
        if (name === 'cancel-edit') return this.cancelEdit();
        if (name === 'save-edit') return this.saveEdit();
        if (name === 'retry') return this.retry(id);
        if (name === 'discard') return this.store.discardPending(this.ctx.key, id.replace('pending:', ''));
      }
      const spoiler = target.closest('.spoiler');
      if (spoiler) return spoiler.classList.add('open');
      const media = target.closest('.media');
      if (media) {
        if (media.classList.contains('spoiler')) return media.classList.remove('spoiler');
        if (media.dataset.embed) {
          // Swap the poster for the site's player, sized like it, and start playing.
          const frame = document.createElement('iframe');
          frame.className = 'embed-player';
          frame.src = media.dataset.embed;
          frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
          frame.allowFullscreen = true;
          frame.referrerPolicy = 'strict-origin-when-cross-origin';
          frame.style.width = media.style.width;
          frame.style.height = media.style.height;
          media.replaceWith(frame);
          return;
        }
        if (media.dataset.href) return openUrl(media.dataset.href);
        const open = media.dataset.open || '';
        if (media.dataset.video) return openUrl(open);
        return lightbox(open, { link: open });
      }
      const jump = target.closest('[data-jump]');
      if (jump) return this.jumpTo(jump.dataset.jump);
    });
    list.addEventListener('contextmenu', event => {
      const row = event.target.closest('.msg');
      if (!row || row.dataset.id.startsWith('pending:')) return;
      if (event.target.closest('a[data-href]') || window.getSelection()?.toString()) return;
      event.preventDefault();
      this.openMenu(row.dataset.id, { x: event.clientX, y: event.clientY });
    });
    list.addEventListener('keydown', event => {
      if (event.target.closest('.edit-box textarea')) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.saveEdit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.cancelEdit();
        }
      }
    });
    list.addEventListener('input', event => {
      if (event.target.matches('.edit-box textarea')) grow(event.target);
    });
  }

  jumpTo(id) {
    const view = this.view(this.ctx.key);
    const node = view.nodes.get(id);
    if (!node) {
      toast('That message is further back than the chat has loaded.', 'info');
      return;
    }
    view.stick = false;
    node.el.scrollIntoView({ block: 'center' });
    node.el.classList.remove('flash');
    void node.el.offsetWidth;
    node.el.classList.add('flash');
  }

  openMenu(id, place) {
    const message = this.message(id);
    if (!message) return;
    const row = this.view(this.ctx.key).nodes.get(id)?.el;
    row?.classList.add('menu-open');
    const ctx = this.ctx;
    const items = [];
    if (message.type !== 'system') {
      if (CAN.react) {
        items.push({ quick: QUICK_REACTIONS.slice(0, 5), pick: emoji => this.react(id, emoji) });
        items.push({ label: 'Add Reaction', icon: 'smilePlus', run: () => this.pickReaction(id, null, place) });
        items.push('sep');
      }
      if (CAN.edit && message.canEdit) items.push({ label: 'Edit Message', icon: 'edit', run: () => this.startEdit(id) });
      if (CAN.reply) items.push({ label: 'Reply', icon: 'reply', run: () => this.startReply(id) });
      if (CAN.pin && message.canPin) items.push({ label: message.pinned ? 'Unpin Message' : 'Pin Message', icon: 'pin', run: () => this.pin(id, !message.pinned) });
      if (items.length) items.push('sep');
      items.push({ label: 'Copy Text', icon: 'copy', run: () => copy(plain(message.content || (message.embeds || []).join('\n'), message.mentions || {})) });
    }
    items.push({ label: 'Copy Message Link', icon: 'link', run: () => copy(this.messageLink(id)) });
    items.push('sep');
    items.push({ label: 'Copy Message ID', run: () => copy(id) });
    if (message.authorId) items.push({ label: 'Copy User ID', run: () => copy(message.authorId) });
    if (CAN.delete && message.canDelete) {
      items.push('sep');
      items.push({ label: 'Delete Message', icon: 'trash', danger: true, run: () => this.remove(id, true) });
    }
    menu(items, { ...place, onClose: () => row?.classList.remove('menu-open') });
    void ctx;
  }

  messageLink(id) {
    const where = this.ctx.where;
    if (where.userId) return `https://discord.com/channels/@me/${this.store.get(this.ctx.key).channelId || this.ctx.channelId || ''}/${id}`;
    return `https://discord.com/channels/${where.guildId}/${where.channelId}/${id}`;
  }

  // ---------------------------------------------------------------- actions (drawn first, then sent)

  async react(id, key, info = null) {
    const ctx = this.ctx;
    const message = this.message(id);
    if (!ctx || !message || !key) return;
    const reactions = (message.reactions || []).map(r => ({ ...r }));
    const existing = reactions.find(r => r.key === key || r.emoji === key);
    const remove = Boolean(existing?.me);
    if (existing) {
      existing.count += remove ? -1 : 1;
      existing.me = !remove;
    } else {
      const custom = /^(.+):(\d+)$/.exec(key);
      reactions.push({ key, emoji: custom ? custom[1] : key, id: custom ? custom[2] : '', url: custom ? (info?.url || `https://cdn.discordapp.com/emojis/${custom[2]}.png?size=48`) : '', count: 1, me: true });
    }
    const before = this.store.patch(ctx.key, id, { reactions: reactions.filter(r => r.count > 0) });
    const result = await post('/api/message/react', { ...ctx.where, messageId: id, emoji: existing?.key || key, remove });
    if (!result.ok) {
      if (before) this.store.restore(ctx.key, before);
      toast(`Reaction failed: ${result.error}`, 'err');
    }
  }

  async pickReaction(id, anchor, place = null) {
    const custom = await this.app.customEmojis(this.ctx?.guildId || '');
    emojiPicker({ anchor: anchor || undefined, x: place?.x, y: place?.y, custom, pick: (key, info) => this.react(id, key, info) });
  }

  startReply(id) {
    const message = this.message(id);
    if (!message || !this.ctx) return;
    this.replying.set(this.ctx.key, { id, authorName: message.authorName, authorId: message.authorId, authorAvatar: message.authorAvatar, content: String(message.content || message.embeds?.[0] || '').slice(0, 300), mentions: message.mentions || {}, attachment: Boolean(message.attachments?.length) });
    this.replyPing = !message.fromBot;
    this.renderBar();
    this.box.focus();
  }

  startEdit(id) {
    const message = this.message(id);
    if (!message?.canEdit || !this.ctx) return;
    this.editing = { key: this.ctx.key, id };
    this.draw(this.ctx.key);
  }

  cancelEdit() {
    if (!this.editing) return;
    const key = this.editing.key;
    this.editing = null;
    this.draw(key);
    this.box.focus();
  }

  async saveEdit() {
    if (!this.editing || !this.ctx) return;
    const { key, id } = this.editing;
    const view = this.view(key);
    const area = view.nodes.get(id)?.el.querySelector('.edit-box textarea');
    const message = this.message(id);
    const text = String(area?.value || '').trim();
    this.editing = null;
    if (!message || text === String(message.editText || message.content || '').trim()) {
      this.draw(key);
      this.box.focus();
      return;
    }
    if (!text && !message.attachments?.length) {
      this.draw(key);
      return this.remove(id, true);
    }
    const limit = message.editStyle === 'embed' ? 4096 : 2000;
    if (text.length > limit) {
      toast(`Messages can be at most ${limit} characters (this one is ${text.length}).`, 'warn');
      this.editing = { key, id };
      return;
    }
    let changes;
    if (message.editStyle === 'embed') {
      const cards = (message.embedCards?.length ? message.embedCards : [{}]).map(c => ({ ...c }));
      cards[0].description = text;
      changes = { embeds: [text, ...(message.embeds || []).slice(1)], embedCards: cards };
    } else {
      changes = { content: text };
    }
    const before = this.store.patch(key, id, { ...changes, edited: true, editText: text });
    this.box.focus();
    const result = await post('/api/message/edit', { ...this.ctx.where, messageId: id, text });
    if (!result.ok) {
      if (before) this.store.restore(key, before);
      toast(`Edit failed: ${result.error}`, 'err');
    } else if (result.data.edited) {
      this.store.upsert(key, result.data.edited);
    }
  }

  async remove(id, ask) {
    const ctx = this.ctx;
    const message = this.message(id);
    if (!ctx || !message) return;
    if (ask && !this.app.shiftDown) {
      const preview = messageHtml({ ...message, reactions: [] }, false, ctx, false).replace('<div class="hoverbar">', '<div class="hoverbar" hidden>');
      const yes = await confirm('Delete Message', '', { yes: 'Delete', html: `<p>Are you sure you want to delete this message?</p><div class="preview">${preview}</div><p class="note" style="margin-top:12px">Tip: hold Shift when you click Delete Message to skip this.</p>` });
      if (!yes) return;
    }
    const before = this.store.remove(ctx.key, id);
    const result = await post('/api/message/delete', { ...ctx.where, messageId: id });
    if (!result.ok) {
      if (before) this.store.restore(ctx.key, before);
      toast(`Delete failed: ${result.error}`, 'err');
    }
  }

  async pin(id, pinned) {
    const ctx = this.ctx;
    const before = this.store.patch(ctx.key, id, { pinned });
    const result = await post('/api/message/pin', { ...ctx.where, messageId: id, pin: pinned });
    if (!result.ok) {
      if (before) this.store.restore(ctx.key, before);
      toast(result.error, 'err');
    } else {
      toast(pinned ? 'Pinned.' : 'Unpinned.', 'ok', 1500);
    }
  }

  // ---------------------------------------------------------------- the message box

  bindComposer() {
    const box = this.box;
    box.addEventListener('input', () => {
      this.autoGrow();
      this.updateAuto();
      this.sendTyping();
    });
    box.addEventListener('keydown', event => {
      if (this.auto && this.autoKey(event)) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      } else if (event.key === 'ArrowUp' && !box.value && !this.auto) {
        const chat = this.ctx && this.store.get(this.ctx.key);
        const last = CAN.edit && chat && [...chat.messages].reverse().find(m => m.canEdit);
        if (last) {
          event.preventDefault();
          this.startEdit(last.id);
        }
      } else if (event.key === 'Escape') {
        if (this.ctx && this.replying.has(this.ctx.key)) {
          event.preventDefault();
          this.replying.delete(this.ctx.key);
          this.renderBar();
        }
      }
    });
    box.addEventListener('paste', event => {
      const files = CAN.upload ? [...(event.clipboardData?.files || [])] : [];
      if (files.length) {
        event.preventDefault();
        this.addFiles(files);
      }
    });
    box.addEventListener('blur', () => setTimeout(() => this.closeAuto(), 150));
    this.root.querySelector('.attach').hidden = !CAN.upload;
    this.root.querySelector('.attach').onclick = () => this.fileInput.click();
    this.fileInput.onchange = () => {
      this.addFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    };
    this.root.querySelector('.send').onclick = () => this.send();
    this.root.querySelector('.emoji').onclick = async event => {
      const custom = await this.app.customEmojis(this.ctx?.guildId || '');
      emojiPicker({ anchor: event.currentTarget, custom, pick: (key, info) => this.insert(info.url ? (/\.gif/.test(info.url) ? `<a:${key}>` : `<:${key}>`) : key) });
    };
    this.styleToggle.addEventListener('click', event => {
      const button = event.target.closest('[data-style]');
      if (!button) return;
      this.style = button.dataset.style;
      this.renderStyle();
    });
    this.renderStyle();
  }

  renderStyle() {
    for (const button of this.styleToggle.querySelectorAll('button')) button.classList.toggle('on', button.dataset.style === this.style);
  }

  insert(text) {
    const box = this.box;
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? box.value.length;
    box.value = box.value.slice(0, start) + text + box.value.slice(end);
    box.selectionStart = box.selectionEnd = start + text.length;
    box.focus();
    this.autoGrow();
  }

  /** Put @name in the message box; it is sent as a real mention, like one picked from the list. */
  mentionUser(id, name) {
    if (!this.ctx) return;
    const label = String(name || 'user');
    const before = this.box.value.slice(0, this.box.selectionStart ?? this.box.value.length);
    this.insert(`${before && !/\s$/.test(before) ? ' ' : ''}@${label} `);
    const picked = this.picked.get(this.ctx.key) || {};
    picked[label] = { kind: 'user', id };
    this.picked.set(this.ctx.key, picked);
  }

  autoGrow() {
    grow(this.box);
  }

  bindDrop() {
    let depth = 0;
    let hint = null;
    const show = on => {
      if (on && !hint) {
        hint = h('<div class="drop-hint">Drop files to send them</div>');
        this.root.appendChild(hint);
      } else if (!on && hint) {
        hint.remove();
        hint = null;
      }
    };
    this.root.addEventListener('dragenter', event => {
      if (!CAN.upload || ![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      depth += 1;
      show(true);
    });
    this.root.addEventListener('dragover', event => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
    });
    this.root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) show(false);
    });
    this.root.addEventListener('drop', event => {
      event.preventDefault();
      depth = 0;
      show(false);
      this.addFiles([...(event.dataTransfer?.files || [])]);
    });
  }

  addFiles(list) {
    if (!CAN.upload || !this.ctx || !list.length) return;
    const files = this.files.get(this.ctx.key) || [];
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const file of list) {
      if (total + file.size > UPLOAD_LIMIT_BYTES) {
        toast(`${file.name} is too big. Harmony sends at most ${formatSize(UPLOAD_LIMIT_BYTES)} of files per message.`, 'warn');
        continue;
      }
      if (files.length >= 10) {
        toast('Up to 10 files per message.', 'warn');
        break;
      }
      total += file.size;
      files.push({ file, name: file.name, size: file.size, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '' });
    }
    this.files.set(this.ctx.key, files);
    this.renderTray();
    this.box.focus();
  }

  renderTray() {
    const files = (this.ctx && this.files.get(this.ctx.key)) || [];
    this.tray.hidden = !files.length;
    this.tray.innerHTML = files.map((f, i) => `<div class="file"><div class="prev">${f.preview ? `<img src="${esc(f.preview)}" alt="">` : icon('file', 's24')}</div><div class="fnm" title="${esc(f.name)}">${esc(f.name)}</div><button class="rm" data-rm="${i}" data-tip="Remove Attachment">${icon('trash', 's16')}</button></div>`).join('');
    for (const button of this.tray.querySelectorAll('[data-rm]')) {
      button.onclick = () => {
        files.splice(Number(button.dataset.rm), 1);
        this.renderTray();
      };
    }
  }

  renderBar() {
    const reply = this.ctx && this.replying.get(this.ctx.key);
    if (!reply) {
      this.bar.hidden = true;
      this.bar.innerHTML = '';
      return;
    }
    this.bar.hidden = false;
    this.bar.innerHTML = `<span class="grow">Replying to <b>${esc(reply.authorName)}</b></span><button class="ping${this.replyPing ? '' : ' off'}" data-tip="${this.replyPing ? 'Click to stop pinging the author' : 'Click to ping the author'}">@ ${this.replyPing ? 'ON' : 'OFF'}</button><button class="icon-btn" style="width:20px;height:20px" data-tip="Cancel reply">${icon('close', 's16')}</button>`;
    this.bar.querySelector('.ping').onclick = () => {
      this.replyPing = !this.replyPing;
      this.renderBar();
    };
    this.bar.querySelector('.icon-btn').onclick = () => {
      this.replying.delete(this.ctx.key);
      this.renderBar();
    };
  }

  renderUnder() {
    if (!this.ctx) return;
    const names = this.app.typing.names(this.ctx.key);
    if (names.length) {
      this.under.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span><span>${typingText(names)[0]}</span>`;
    } else {
      this.under.innerHTML = `<span>${esc(this.ctx.hint || '')}</span>`;
    }
  }

  sendTyping() {
    const ctx = this.ctx;
    if (!CAN.typing || !ctx || !this.box.value.trim()) return;
    const now = Date.now();
    if (now - this.typingSent < 8000) return;
    this.typingSent = now;
    post('/api/typing', ctx.where);
  }

  async send() {
    const ctx = this.ctx;
    if (!ctx) return;
    const shown = this.box.value.trim();
    const text = applyMentions(shown, this.picked.get(ctx.key) || {});
    const files = [...(this.files.get(ctx.key) || [])];
    if (!text && !files.length) return;
    const style = ctx.plainOnly ? 'plain' : this.style;
    const limit = style === 'plain' ? 2000 : 4096;
    if (text.length > limit) {
      toast(`${style === 'plain' ? 'Messages' : 'Box messages'} can be at most ${limit} characters (this one is ${text.length}).`, 'warn');
      return;
    }
    const key = ctx.key;
    const where = { ...ctx.where };
    const reply = this.replying.get(key) || null;
    const ping = this.replyPing;
    const id = nonce();
    for (const old of this.store.get(key).pending.filter(p => p.error)) this.store.discardPending(key, old.nonce);
    this.store.addPending(key, { nonce: id, shown, text, style, createdAt: Date.now(), reply, attachments: files.map(f => ({ name: f.name, size: f.size, url: '' })), files, where });
    this.box.value = '';
    this.drafts.delete(key);
    this.picked.delete(key);
    this.files.delete(key);
    this.replying.delete(key);
    this.typingSent = 0;
    this.autoGrow();
    this.renderBar();
    this.renderTray();
    this.view(key).stick = true;
    await this.deliver(key, id);
  }

  async deliver(key, id) {
    const pending = this.store.get(key).pending.find(p => p.nonce === id);
    if (!pending) return;
    const { text, style, reply, files, where } = pending;
    const body = { text, nonce: id };
    if (reply) Object.assign(body, { replyTo: reply.id, replyPing: this.replyPing });
    if (files?.length) {
      try {
        body.files = await Promise.all(files.map(async f => ({ name: f.name, data: await fileToBase64(f.file) })));
      } catch (error) {
        this.store.failPending(key, id, `Could not read the files: ${error}`);
        return;
      }
    }
    const result = where.userId
      ? await post('/api/dm/send', { ...body, userId: where.userId }, files?.length ? 120000 : undefined)
      : await post('/api/say', { ...body, guildId: where.guildId, channelId: where.channelId, style }, files?.length ? 120000 : undefined);
    if (result.ok) {
      if (result.data.sent) this.store.resolvePending(key, id, result.data.sent);
      else {
        this.store.discardPending(key, id);
        this.app.reloadChat?.(key);
      }
    } else {
      this.store.failPending(key, id, result.error);
      this.app.log('warn', `Chat: ${result.error}`);
    }
  }

  retry(rowId) {
    const id = rowId.replace('pending:', '');
    const pending = this.store.get(this.ctx.key).pending.find(p => p.nonce === id);
    if (!pending) return;
    pending.error = '';
    this.store.stamp(pending);
    this.store.changed(this.ctx.key);
    this.deliver(this.ctx.key, id);
  }

  // ---------------------------------------------------------------- @mentions

  updateAuto() {
    const box = this.box;
    const before = box.value.slice(0, box.selectionStart ?? box.value.length);
    const query = mentionQuery(before);
    if (!CAN.mentionSearch || query === null || !this.ctx) {
      this.closeAuto();
      return;
    }
    this.askMentions(query);
  }

  askMentions = debounce(async query => {
    const ctx = this.ctx;
    if (!ctx) return;
    const result = await get('/api/mentions', { guildId: ctx.guildId || '', q: query });
    const current = mentionQuery(this.box.value.slice(0, this.box.selectionStart ?? this.box.value.length));
    if (current !== query || this.ctx !== ctx) return;
    const items = result.ok ? result.data.mentions || [] : [];
    if (!items.length) {
      this.closeAuto();
      return;
    }
    this.auto = { query, items, index: 0 };
    this.renderAuto();
  }, 90);

  renderAuto() {
    let el = this.composer.querySelector('.auto');
    if (!this.auto) {
      el?.remove();
      return;
    }
    if (!el) {
      el = h('<div class="auto"></div>');
      el.addEventListener('mousedown', event => {
        event.preventDefault();
        const it = event.target.closest('.it');
        if (it) this.pickMention(Number(it.dataset.i));
      });
      this.composer.appendChild(el);
    }
    const { items, index, query } = this.auto;
    el.innerHTML = `<div class="h">Members${query ? ` matching @${esc(query)}` : ''}</div>${items.map((item, i) => `<div class="it${i === index ? ' sel' : ''}" data-i="${i}"><span class="avatar s24">${item.kind === 'user' ? esc(initials(item.name).slice(0, 2)) : (item.kind === 'role' ? '@' : '@')}</span><span class="nm">${item.kind === 'role' ? '@' : ''}${esc(item.name)}</span><span class="us">${esc(item.kind === 'user' ? item.username : item.kind === 'role' ? 'role' : 'notify everyone')}</span></div>`).join('')}`;
  }

  autoKey(event) {
    const auto = this.auto;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      auto.index = (auto.index + (event.key === 'ArrowDown' ? 1 : -1) + auto.items.length) % auto.items.length;
      this.renderAuto();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.pickMention(auto.index);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeAuto();
      return true;
    }
    return false;
  }

  pickMention(index) {
    const item = this.auto?.items[index];
    if (!item || !this.ctx) return;
    const box = this.box;
    const cursor = box.selectionStart ?? box.value.length;
    const before = box.value.slice(0, cursor);
    const at = before.lastIndexOf('@');
    const label = item.name;
    box.value = `${box.value.slice(0, at)}@${label} ${box.value.slice(cursor)}`;
    box.selectionStart = box.selectionEnd = at + label.length + 2;
    const picked = this.picked.get(this.ctx.key) || {};
    picked[label] = { kind: item.kind, id: item.id };
    this.picked.set(this.ctx.key, picked);
    this.closeAuto();
    box.focus();
  }

  closeAuto() {
    this.auto = null;
    this.renderAuto();
  }

  // ---------------------------------------------------------------- pins

  async openPins(anchor) {
    const ctx = this.ctx;
    if (!ctx) return;
    const el = h(`<div class="pins" style="width:420px;max-height:70vh"><div class="ph">${icon('pin')}<span>Pinned Messages</span></div><div class="pb"><div class="note" style="padding:12px">Loading…</div></div></div>`);
    popover(el, { anchor });
    const result = await get('/api/pins', ctx.where);
    const body = el.querySelector('.pb');
    if (!result.ok) {
      body.innerHTML = `<div class="note err" style="padding:12px">${esc(result.error)}</div>`;
      return;
    }
    const messages = result.data.messages || [];
    if (!messages.length) {
      body.innerHTML = '<div class="empty" style="padding:24px"><div class="big-ico">' + icon('pin') + '</div><p>This chat doesn\'t have any pinned messages... yet.</p></div>';
      return;
    }
    body.innerHTML = messages.map(m => `<div class="pin msg" data-id="${esc(m.id)}"><div class="av">${avatarHtml(m.authorAvatar, m.authorName)}</div><div class="hdr">${nameHtml(m.authorName, m.authorStyle, { cls: 'author' })}<span class="time">${esc(formatWhen(m.createdAt))}</span></div><div class="body md">${render(m.content || (m.embeds || [])[0] || '', m.mentions || {})}</div><div class="tools"><button class="btn small" data-jump="${esc(m.id)}">Jump</button>${m.canPin ? `<button class="icon-btn" data-unpin="${esc(m.id)}" data-tip="Unpin">${icon('close', 's16')}</button>` : ''}</div></div>`).join('');
    body.addEventListener('click', async event => {
      const jump = event.target.closest('[data-jump]');
      if (jump) {
        closeFloat();
        this.jumpTo(jump.dataset.jump);
        return;
      }
      const unpin = event.target.closest('[data-unpin]');
      if (unpin) {
        const answer = await post('/api/message/pin', { ...ctx.where, messageId: unpin.dataset.unpin, pin: false });
        if (answer.ok) unpin.closest('.pin').remove();
        else toast(answer.error, 'err');
      }
    });
  }
}

function grow(area) {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, window.innerHeight * 0.4)}px`;
}

export { api };
