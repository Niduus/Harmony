// Floating things: context menus, popovers, modals, toasts, tooltips, the picture viewer and the emoji picker.

import { esc, h } from './util.js';
import { icon } from './icons.js';
import { invoke } from './bridge.js';

const layer = () => document.getElementById('layer');

// ------------------------------------------------------------------ toasts

export function toast(text, level = 'info', ms = 3800) {
  if (!text) return;
  const box = document.getElementById('toasts');
  const el = h(`<div class="toast ${esc(level)}"><span class="d"></span><span>${esc(text)}</span></div>`);
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ tooltip

let tipTarget = null;
export function bindTooltips(root) {
  const tip = document.getElementById('tooltip');
  root.addEventListener('mouseover', event => {
    const target = event.target.closest('[data-tip]');
    if (!target || target === tipTarget) return;
    tipTarget = target;
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const side = target.dataset.tipSide || 'top';
    tip.className = `tooltip ${side}`;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (side === 'right') {
      tip.style.left = `${rect.right + 12}px`;
      tip.style.top = `${rect.top + rect.height / 2 - th / 2}px`;
    } else {
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, rect.left + rect.width / 2 - tw / 2))}px`;
      tip.style.top = `${rect.top - th - 8}px`;
    }
  });
  root.addEventListener('mouseout', event => {
    if (tipTarget && !tipTarget.contains(event.relatedTarget)) {
      tipTarget = null;
      tip.hidden = true;
    }
  });
  root.addEventListener('mousedown', () => {
    tipTarget = null;
    tip.hidden = true;
  });
}

// ------------------------------------------------------------------ menus and popovers

let openFloat = null;

export function closeFloat() {
  if (openFloat) {
    const { el, onClose } = openFloat;
    openFloat = null;
    el.remove();
    onClose?.();
  }
}

function place(el, x, y, anchor) {
  layer().appendChild(el);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = anchor.dataset.popAlign === 'left' ? r.left : r.right - w;
    y = r.bottom + 8;
    if (y + hgt > window.innerHeight - 8) y = Math.max(8, r.top - hgt - 8);
  } else {
    if (x + w > window.innerWidth - 8) x = Math.max(8, x - w);
    if (y + hgt > window.innerHeight - 8) y = Math.max(8, window.innerHeight - hgt - 8);
  }
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

function float(el, { x = 0, y = 0, anchor = null, onClose = null } = {}) {
  closeFloat();
  place(el, x, y, anchor);
  openFloat = { el, onClose };
  return el;
}

document.addEventListener('mousedown', event => {
  if (openFloat && !openFloat.el.contains(event.target) && !event.target.closest('[data-keep-float]')) closeFloat();
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openFloat) {
    closeFloat();
    event.stopPropagation();
  }
}, true);
window.addEventListener('blur', () => closeFloat());
window.addEventListener('resize', () => closeFloat());

/** items: [{label, icon?, danger?, disabled?, run}] | 'sep' | {quick: [emoji], pick} */
export function menu(items, { x, y, anchor, onClose } = {}) {
  const el = h('<div class="menu" role="menu"></div>');
  for (const item of items) {
    if (!item) continue;
    if (item === 'sep') {
      if (el.lastElementChild && !el.lastElementChild.classList.contains('sep')) el.appendChild(h('<div class="sep"></div>'));
      continue;
    }
    if (item.quick) {
      const row = h('<div class="quick"></div>');
      for (const emoji of item.quick) {
        const button = h(`<button title="${esc(emoji)}">${esc(emoji)}</button>`);
        button.onclick = () => {
          closeFloat();
          item.pick(emoji);
        };
        row.appendChild(button);
      }
      el.appendChild(row);
      continue;
    }
    const row = h(`<div class="mi${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}"><span class="grow">${esc(item.label)}</span>${item.icon ? icon(item.icon, 's18') : ''}</div>`);
    row.onclick = () => {
      closeFloat();
      item.run?.();
    };
    el.appendChild(row);
  }
  if (el.lastElementChild?.classList.contains('sep')) el.lastElementChild.remove();
  return float(el, { x, y, anchor, onClose });
}

export function popover(el, options) {
  el.classList.add('pop');
  return float(el, options);
}

// ------------------------------------------------------------------ modals

export function modal({ title, body = '', buttons = [], wide = false, onClose = null }) {
  closeFloat();
  const back = h(`<div class="modal-back"><div class="modal${wide ? ' wide' : ''}" role="dialog"><div class="mh"><h2>${esc(title)}</h2></div><div class="mb"></div><div class="mf"></div></div></div>`);
  const content = back.querySelector('.mb');
  if (typeof body === 'string') content.innerHTML = body;
  else content.appendChild(body);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const foot = back.querySelector('.mf');
  if (!buttons.length) foot.remove();
  for (const button of buttons) {
    const el = h(`<button class="btn ${button.kind || ''}">${esc(button.label)}</button>`);
    el.onclick = async () => {
      if (button.run) {
        const keep = await button.run(content);
        if (keep === false) return;
      }
      close();
    };
    foot.appendChild(el);
  }
  const onKey = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && !event.shiftKey && event.target.tagName !== 'TEXTAREA') {
      const primary = [...foot.querySelectorAll('.btn')].pop();
      if (primary && document.body.contains(back)) {
        event.preventDefault();
        primary.click();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', event => {
    if (event.target === back) close();
  });
  document.body.appendChild(back);
  const focus = back.querySelector('input, textarea, select');
  (focus || foot.lastElementChild)?.focus?.();
  return { el: back, body: content, close };
}

export function confirm(title, text, { yes = 'Confirm', danger = true, html = '' } = {}) {
  return new Promise(resolve => {
    let answered = false;
    modal({
      title,
      body: html || `<p>${esc(text)}</p>`,
      buttons: [
        { label: 'Cancel', kind: 'ghost', run: () => { answered = true; resolve(false); } },
        { label: yes, kind: danger ? 'red' : 'primary', run: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/** Ask for one line (or a few) of text. Resolves to the text, or null on cancel. */
export function prompt(title, { label = '', value = '', placeholder = '', multiline = false, yes = 'Save', extra = null, note = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    const field = multiline
      ? `<textarea class="field" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="field" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const buttons = [{ label: 'Cancel', kind: 'ghost', run: () => { done = true; resolve(null); } }];
    if (extra) buttons.push({ label: extra.label, kind: extra.kind || '', run: () => { done = true; resolve(extra.value); } });
    buttons.push({ label: yes, kind: 'primary', run: body => { done = true; resolve(body.querySelector('.field').value); } });
    modal({
      title,
      body: `${label ? `<div class="label-sm">${esc(label)}</div>` : ''}${field}${note ? `<p class="note" style="margin-top:8px">${esc(note)}</p>` : ''}`,
      buttons,
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

export function textViewer(title, text) {
  modal({ title, body: `<div class="text-view">${esc(text || '(empty)')}</div>`, wide: true, buttons: [{ label: 'Close', kind: 'primary' }] });
}

// ------------------------------------------------------------------ picture viewer

export function lightbox(src, { video = false, link = '' } = {}) {
  const box = h(`<div class="lightbox">${video ? `<video src="${esc(src)}" controls autoplay></video>` : `<img src="${esc(src)}" alt="">`}<a data-href="${esc(link || src)}">Open in Browser</a></div>`);
  box.addEventListener('click', event => {
    if (event.target === box) close();
  });
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
}

// ------------------------------------------------------------------ copying and links

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied to clipboard.', 'ok', 1600);
}

export function openUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return;
  invoke('open_url', { url }).catch(() => {});
}

// ------------------------------------------------------------------ emoji picker

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];

const EMOJI_GROUPS = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 💀 👻 👽 🤖 💩 😺 😸 😹 😻 😼 🙈 🙉 🙊'],
  ['People', '👍 👎 👏 🙌 👐 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 👈 👉 👆 👇 ☝️ ✋ 🤚 👋 💪 🫡 🫠 🫶 👀 🧠 🦾 💅 🤳'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💤'],
  ['Things', '🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🎁 🏆 🥇 🎮 🎵 🎶 🎤 🎧 📌 ✅ ❌ ⚠️ ❓ ❗ 🍕 🍔 🍟 🌮 🍩 🍪 🎂 🍺 🍻 ☕ 🌈 🌙 ☀️ 🌧️ ❄️ 🌹 🌸 💐 🍀 🐶 🐱 🦊 🐸 🐍 🦄 🐉 🚀 💎 💰 🔒 🔑 🎲 🃏 ♠️ ♥️ ♦️ ♣️'],
];

/** Pick a unicode emoji or one of your servers' custom emojis. pick(key, info) gets 'emoji' or 'name:id'. */
export function emojiPicker({ anchor, x, y, custom = [], pick }) {
  const el = h(`<div class="emoji-pop">
    <div class="search"><input class="field" placeholder="Find the perfect emoji" style="height:32px;font-size:14px"></div>
    <div class="grid"></div>
    <div class="foot"><span class="big">🙂</span><span class="nm">Pick an emoji</span></div>
  </div>`);
  const grid = el.querySelector('.grid');
  const foot = el.querySelector('.foot');
  const input = el.querySelector('input');
  const fill = query => {
    query = query.trim().toLowerCase();
    let html = '';
    const customs = custom.filter(e => !query || String(e.name).toLowerCase().includes(query));
    if (customs.length) {
      const byGuild = new Map();
      for (const e of customs) {
        if (!byGuild.has(e.guild)) byGuild.set(e.guild, []);
        byGuild.get(e.guild).push(e);
      }
      for (const [guild, list] of byGuild) {
        html += `<div class="gh">${esc(guild || 'Server')}</div><div class="cells">${list.map(e => `<div class="cell" data-key="${esc(e.key)}" data-name=":${esc(e.name)}:" data-url="${esc(e.url)}"><img src="${esc(e.url)}" alt="" loading="lazy"></div>`).join('')}</div>`;
      }
    }
    if (!query) {
      for (const [name, list] of EMOJI_GROUPS) {
        html += `<div class="gh">${esc(name)}</div><div class="cells">${list.split(' ').map(e => `<div class="cell" data-key="${e}" data-name="${e}">${e}</div>`).join('')}</div>`;
      }
    } else if (!customs.length) {
      html = '<div class="note" style="padding:16px">No custom emoji match. Clear the search to see every emoji.</div>';
    }
    grid.innerHTML = html;
  };
  fill('');
  input.addEventListener('input', () => fill(input.value));
  grid.addEventListener('mouseover', event => {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    foot.innerHTML = cell.dataset.url ? `<img src="${esc(cell.dataset.url)}" style="width:28px;height:28px"><span>${esc(cell.dataset.name)}</span>` : `<span class="big">${esc(cell.dataset.key)}</span>`;
  });
  grid.addEventListener('click', event => {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    const keep = event.shiftKey;
    pick(cell.dataset.key, { name: cell.dataset.name, url: cell.dataset.url || '' });
    if (!keep) closeFloat();
  });
  popover(el, { anchor, x, y });
  setTimeout(() => input.focus(), 0);
  return el;
}
