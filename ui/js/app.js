// Harmony's window: the server rail, the sidebars, the chat and the settings page, laid out
// like the Discord client. The layout and chat are a copy of hbv's panel, cut down to what a
// personal client needs. All state lives in S; draw() redraws only what changed (setHtml skips
// identical HTML, so nothing on screen flashes when data refreshes).

import { invoke, listen, get } from './bridge.js';
import { icon, logo } from './icons.js';
import { esc, h, debounce, groupChannels, initials } from './util.js';
import { toast, bindTooltips, menu, modal, confirm, copy, openUrl, closeFloat } from './ui.js';
import { ChatStore, Typing, ChatPane } from './chat.js';
import { plain } from './markdown.js';

// ================================================================== state

const S = {
  init: null,
  signedIn: false,
  settings: {},
  status: { state: 'offline', text: '' },
  release: {},
  releaseBusy: false,
  overview: null,
  guilds: new Map(),
  guildErrors: new Map(),
  dms: null,
  view: load('view', { place: 'dms' }),
  lastInGuild: load('lastInGuild', {}),
  collapsed: new Set(load('collapsed', [])),
  unreadGuilds: new Set(),
  unreadChannels: new Set(),
  dmFilter: '',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(`harmony.${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`harmony.${key}`, JSON.stringify(value));
  } catch {
    // Storage is a convenience only.
  }
}

// What ChatPane needs from the app.
const app = {
  chats: new ChatStore(),
  typing: null,
  live: false,
  shiftDown: false,
  botAuthor() {
    const me = S.overview?.bot || {};
    return { id: me.id || '', name: me.name || 'You', avatar: me.avatar || '' };
  },
  customEmojis() {
    return Promise.resolve([]);
  },
  log() {},
  onDmRead(userId) {
    const entry = S.dms?.conversations?.find(c => c.userId === userId);
    if (entry && entry.unread) {
      S.dms.unread = Math.max(0, (S.dms.unread || 0) - entry.unread);
      entry.unread = 0;
    }
    draw();
  },
  reloadChat(key) {
    if (chat.ctx?.key === key) chat.load(chat.ctx, { force: true, quiet: true });
  },
};
app.typing = new Typing(key => {
  if (chat.ctx?.key === key) chat.renderUnder();
});
const chat = new ChatPane(app);

// ================================================================== drawing helpers

/** Replace el's content only when the HTML changed, keeping focus in a text field. */
function setHtml(el, html) {
  if (el._html === html) return false;
  const active = document.activeElement;
  const keep = active && el.contains(active) ? active.dataset.keep : null;
  const selection = keep && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const value = keep ? active.value : null;
  el.innerHTML = html;
  el._html = html;
  if (keep) {
    const node = el.querySelector(`[data-keep="${CSS.escape(keep)}"]`);
    if (node) {
      node.value = value;
      node.focus();
      if (selection) node.setSelectionRange(...selection);
    }
  }
  return true;
}

const $ = id => document.getElementById(id);
const appEl = $('app');
const loginEl = $('login');
const rail = $('rail');
const sideHead = $('side-head');
const sideBody = $('side-body');
const userPanel = $('user-panel');
const main = $('main');
main.innerHTML = '<div class="topbar" id="topbar"></div><div class="mrow"><div id="mbody" style="flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;position:relative"></div></div>';
const topbarEl = $('topbar');
const mbody = $('mbody');
const pageEl = h('<div class="page"><div class="page-inner"></div></div>');
const pageInner = pageEl.firstElementChild;
const emptyEl = h('<div style="flex:1;display:flex;flex-direction:column;min-height:0"></div>');

function mount(...nodes) {
  const now = [...mbody.children];
  if (now.length === nodes.length && now.every((n, i) => n === nodes[i])) return;
  mbody.replaceChildren(...nodes);
}

let pageKey = '';
function showPage(key, html) {
  mount(pageEl);
  if (pageKey !== key) {
    pageKey = key;
    pageInner._html = null;
    pageEl.scrollTop = 0;
  }
  setHtml(pageInner, html);
}

function showEmpty(html) {
  pageKey = '';
  mount(emptyEl);
  setHtml(emptyEl, html);
}

const avatar = (url, name, cls = '', dot = '') => `<span class="avatar ${cls}">${url ? `<img src="${esc(url)}" alt="" draggable="false">` : esc(initials(name).slice(0, 2))}${dot ? `<span class="dot ${dot}"></span>` : ''}</span>`;

function topbar({ ico = '', img = '', title, topic = '', actions = '' }) {
  const lead = img ? avatar(img.trim(), title, 's24') : (ico ? `<span class="ico">${icon(ico, 's24')}</span>` : '');
  return `<div class="ttl">${lead}<span class="nm">${esc(title)}</span></div>${topic ? `<div class="divider"></div><div class="topic">${topic}</div>` : '<div class="topic"></div>'}<div class="actions">${actions}</div>`;
}

const empty = (ico, title, text, extra = '') => `<div class="empty"><div class="big-ico">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;
const card = (title, body, sub = '') => `<div class="card"><h2>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h2>${body}</div>`;
const sw = (on, attrs, disabled = false) => `<button class="switch${on ? ' on' : ''}" ${attrs}${disabled ? ' disabled' : ''} role="switch" aria-checked="${on ? 'true' : 'false'}"></button>`;
const setting = (name, desc, control) => `<div class="setting"><div class="txt"><div class="nm">${name}</div>${desc ? `<div class="ds">${desc}</div>` : ''}</div>${control}</div>`;
const btn = (label, attrs, kind = '', ico = '') => `<button class="btn ${kind}" ${attrs}>${ico ? icon(ico) : ''}${esc(label)}</button>`;

const STATE_DOT = { online: 'online', connecting: 'idle', reconnecting: 'idle', offline: 'offline' };

let frame = 0;
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    appEl.hidden = !S.signedIn;
    loginEl.hidden = S.signedIn;
    if (!S.signedIn) return drawLogin();
    drawRail();
    drawSide();
    drawUser();
    drawMain();
  });
}

// ================================================================== signing in

function drawLogin() {
  if (loginEl._drawn) return;
  loginEl._drawn = true;
  loginEl.innerHTML = `<div class="login-card">
    <div class="login-logo">${logo()}</div>
    <h1>Welcome to Harmony</h1>
    <p class="lead">A fast, native Discord client.</p>
    <div class="note warn login-warn">Third-party clients are against Discord's Terms of Service, and accounts can be banned for using one. Use a test account you can afford to lose.</div>
    <div class="login-error note err" hidden></div>
    <button class="btn primary big wide" data-do="login-discord">Sign in with Discord</button>
    <p class="note">Opens Discord's own sign-in page in a private window. You type your email, password and any 2FA code there, not into Harmony. Harmony keeps only the session it gets back, in your system's secure keychain.</p>
    <div class="login-or"><span>or paste a token</span></div>
    <label class="label-sm" for="login-token">Account token</label>
    <input id="login-token" class="field" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your token">
    <p class="note">Only Harmony's core ever sees it. Never paste it anywhere else.</p>
    <button class="btn big wide" data-do="login">Sign in with token</button>
  </div>`;
  const field = loginEl.querySelector('#login-token');
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') ACTIONS.login();
  });
  requestAnimationFrame(() => field.focus());
}

function loginError(text) {
  const el = loginEl.querySelector('.login-error');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
}

async function signIn() {
  const field = loginEl.querySelector('#login-token');
  const token = field?.value || '';
  if (!token.trim()) return loginError('Paste your token first.');
  const result = await invoke('login', { token }).catch(error => ({ ok: false, message: String(error) }));
  // The token leaves the page either way: it lives in the core and the keychain only.
  if (field) field.value = '';
  if (!result.ok) return loginError(result.message);
  loginError('');
  S.signedIn = true;
  S.status = { state: 'connecting', text: 'Connecting…' };
  draw();
}

async function signInWithDiscord() {
  loginError('');
  const result = await invoke('login_discord').catch(error => ({ ok: false, message: String(error) }));
  if (!result.ok) loginError(result.message);
}

/** The Discord sign-in window finished (login_window.rs). */
function onSignedIn(result) {
  if (!result.ok) return loginError(result.message);
  loginError('');
  S.signedIn = true;
  S.status = { state: 'connecting', text: 'Connecting…' };
  if (result.message && result.message.includes('(')) toast(result.message, 'warn', 9000);
  draw();
}

async function signOut() {
  if (!(await confirm('Sign Out', 'Harmony disconnects and removes your token from this PC. You\'ll need to paste it again to sign in.', { yes: 'Sign out' }))) return;
  const result = await invoke('logout');
  toast(result.message, result.ok ? 'ok' : 'err');
  resetSession();
}

function resetSession() {
  S.signedIn = false;
  S.overview = null;
  S.guilds.clear();
  S.dms = null;
  S.unreadGuilds.clear();
  S.unreadChannels.clear();
  for (const key of [...app.chats.chats.keys()]) app.chats.forget(key);
  loginEl._drawn = false;
  draw();
}

// ================================================================== the server rail

function railItem({ key, active, unread, tip, inner, cls = '', badge = 0, attrs = '' }) {
  return `<div class="rail-item${active ? ' active' : ''}${unread ? ' unread' : ''}" ${attrs} data-rail="${esc(key)}"><div class="rail-pill"></div><button class="rail-btn ${cls}" data-tip="${esc(tip)}" data-tip-side="right">${inner}</button>${badge ? `<span class="rail-badge">${badge > 99 ? '99+' : badge}</span>` : ''}</div>`;
}

function drawRail() {
  const v = S.view;
  let html = railItem({ key: 'dms', active: v.place === 'dms', tip: 'Direct Messages', inner: logo(), cls: 'home', badge: S.dms?.unread || 0, attrs: 'data-go="dms"' });
  html += '<div class="rail-sep"></div>';
  for (const g of S.overview?.guilds || []) {
    const active = v.place === 'guild' && v.guildId === g.id;
    html += railItem({
      key: `g:${g.id}`, active, unread: !active && S.unreadGuilds.has(g.id), tip: g.name,
      inner: g.icon ? `<img src="${esc(g.icon)}" alt="" draggable="false">` : esc(initials(g.name)), cls: g.icon ? 'has-img' : '', attrs: `data-guild="${esc(g.id)}"`,
    });
  }
  if (!S.overview) html += '<div class="rail-note">loading…</div>';
  html += '<div class="rail-spacer"></div>';
  html += `<div class="rail-note">${esc(S.init?.displayVersion || '')}</div>`;
  setHtml(rail, html);
}

// ================================================================== sidebars

let sideKey = '';
function drawSide() {
  const v = S.view;
  const key = v.place === 'guild' ? `guild:${v.guildId}` : v.place;
  if (key !== sideKey) {
    sideKey = key;
    sideBody._html = null;
    sideHead._html = null;
    requestAnimationFrame(() => { sideBody.scrollTop = 0; });
  }
  if (v.place === 'guild') drawGuildSide();
  else drawDmSide();
}

function dmRows() {
  const list = S.dms?.conversations || [];
  const filter = S.dmFilter.trim().toLowerCase();
  return filter ? list.filter(c => `${c.name} ${c.username}`.toLowerCase().includes(filter)) : list;
}

function drawDmSide() {
  sideHead.className = 'side-head';
  setHtml(sideHead, '<input class="side-search" data-keep="dm-search" data-input="dm-search" placeholder="Find a conversation">');
  const v = S.view;
  let html = '<div class="dm-head"><span>Direct Messages</span></div>';
  if (!S.dms) html += '<div class="side-note">Loading…</div>';
  for (const c of dmRows()) {
    const active = v.place === 'dms' && v.userId === c.userId;
    html += `<div class="dm-row${active ? ' active' : ''}${c.unread ? ' unread' : ''}" data-dm="${esc(c.userId)}">${avatar(c.avatar, c.name)}<div class="texts"><div class="nm">${esc(c.name)}</div><div class="pv">${esc(plain(c.lastPreview || '').slice(0, 80))}</div></div>${c.unread && !active ? `<span class="badge">${c.unread}</span>` : ''}</div>`;
  }
  if (S.dms && !dmRows().length) html += `<div class="side-note">${S.dmFilter.trim() ? 'No conversation matches.' : 'No conversations yet.'}</div>`;
  setHtml(sideBody, html);
}

function channelIcon(c) {
  if (c.kind === 'voice') return 'speaker';
  if (c.kind === 'forum') return 'forum';
  return 'hash';
}

function drawGuildSide() {
  const v = S.view;
  const detail = S.guilds.get(v.guildId);
  const meta = S.overview?.guilds?.find(g => g.id === v.guildId);
  sideHead.className = 'side-head clickable';
  setHtml(sideHead, `<span class="grow" data-do="guild-menu">${esc(detail?.guild?.name || meta?.name || 'Server')}</span><span data-do="guild-menu" style="display:flex">${icon('chevron', 's18')}</span>`);
  if (!detail) {
    setHtml(sideBody, `<div class="side-note">${esc(S.guildErrors.get(v.guildId) || 'Loading channels…')}</div>`);
    return;
  }
  let html = '';
  for (const [name, items] of groupChannels(detail.channels || [])) {
    const ck = `${v.guildId}:${name}`;
    const collapsed = name && S.collapsed.has(ck);
    if (name) html += `<div class="cat${collapsed ? ' collapsed' : ''}" data-cat="${esc(ck)}">${icon('chevron')}<span class="label">${esc(name)}</span></div>`;
    for (const c of items) {
      const active = v.channelId === c.id;
      const unread = S.unreadChannels.has(c.id) && !active;
      if (collapsed && !active && !unread) continue;
      const cls = ['ch', active ? 'active' : '', c.muted || c.kind !== 'text' ? 'muted' : '', unread ? 'unread' : ''].filter(Boolean).join(' ');
      html += `<div class="${cls}" data-ch="${esc(c.id)}" data-kind="${esc(c.kind)}"><span class="ico">${icon(channelIcon(c), 's18')}</span><span class="name">${esc(c.name)}</span><span class="meta"></span></div>`;
    }
  }
  setHtml(sideBody, html);
}

function drawUser() {
  const me = S.overview?.bot || {};
  const st = S.status || {};
  setHtml(userPanel, `<div class="who" data-tip="${esc(st.text || '')}">${avatar(me.avatar, me.name || 'You', '', STATE_DOT[st.state] || 'offline')}<div class="names"><div class="nm">${esc(me.name || 'You')}</div><div class="st">${esc(st.text || '')}</div></div></div>
    <button class="icon-btn" data-go="settings" data-tip="Settings">${icon('gear', 's18')}</button>`);
}

// ================================================================== main area

function drawMain() {
  const v = S.view;
  if (v.place === 'settings') return drawSettings();
  if (v.place === 'guild') return drawGuild();
  return drawDm();
}

function drawGuild() {
  const v = S.view;
  const detail = S.guilds.get(v.guildId);
  const meta = S.overview?.guilds?.find(g => g.id === v.guildId);
  const name = detail?.guild?.name || meta?.name || 'Server';
  const c = detail?.channels?.find(x => x.id === v.channelId);
  if (!detail || !c) {
    setHtml(topbarEl, topbar({ ico: 'grid', title: name }));
    const error = S.guildErrors.get(v.guildId);
    if (error) return showEmpty(empty('close', "Can't open this server", error));
    return showEmpty(detail ? empty('hash', name, 'Pick a channel on the left.') : '<div class="empty"><p>Loading…</p></div>');
  }
  setHtml(topbarEl, topbar({ ico: channelIcon(c), title: c.name }));
  if (c.kind === 'voice') return showEmpty(empty('speaker', c.name, 'Voice channels arrive in Phase 3 of the roadmap.'));
  if (c.kind !== 'text') return showEmpty(empty('forum', c.name, 'Forums and threads arrive in a later phase.'));
  pageKey = '';
  mount(chat.root);
  openChat(channelCtx(detail, c));
}

function channelCtx(detail, c) {
  return {
    key: `ch:${c.id}`,
    where: { guildId: detail.guild.id, channelId: c.id },
    name: `#${c.name}`,
    guildId: detail.guild.id,
    channelId: c.id,
    plainOnly: true,
    intro: { icon: 'hash', title: `Welcome to #${c.name}!`, text: `This is the start of the #${c.name} channel.` },
    placeholder: `Message #${c.name}`,
    hint: 'Enter sends, Shift+Enter is a new line.',
  };
}

function dmInfo(userId) {
  const c = S.dms?.conversations?.find(x => x.userId === userId);
  const u = app.chats.get(`dm:${userId}`).user;
  return { name: c?.name || u?.name || 'Direct Message', avatar: c?.avatar || u?.avatar || '', username: c?.username || u?.username || '' };
}

function dmCtx(userId) {
  const info = dmInfo(userId);
  return {
    key: `dm:${userId}`,
    where: { userId },
    name: `@${info.name}`,
    guildId: '',
    plainOnly: true,
    intro: { img: info.avatar, icon: 'at', title: info.name, text: `This is the beginning of your direct message history with ${info.name}.` },
    placeholder: `Message @${info.name}`,
    hint: 'Enter sends, Shift+Enter is a new line.',
  };
}

function drawDm() {
  const userId = S.view.userId;
  if (!userId) {
    setHtml(topbarEl, topbar({ ico: 'users', title: 'Direct Messages' }));
    const count = S.dms?.conversations?.length || 0;
    return showEmpty(empty('mail', 'Direct Messages', count ? 'Pick a conversation on the left.' : 'Your conversations show up here.'));
  }
  const info = dmInfo(userId);
  setHtml(topbarEl, topbar({ img: info.avatar || ' ', title: info.name, topic: info.username ? esc(info.username) : '', actions: `<button class="icon-btn" data-do="copy" data-text="${esc(userId)}" data-tip="Copy User ID">${icon('copy')}</button>` }));
  pageKey = '';
  mount(chat.root);
  openChat(dmCtx(userId));
}

let chatSig = '';
function openChat(ctx) {
  const sig = JSON.stringify([ctx.key, ctx.name, ctx.placeholder, ctx.intro]);
  if (sig === chatSig) return;
  const fresh = chat.ctx?.key !== ctx.key;
  chatSig = sig;
  chat.open(ctx);
  if (fresh) {
    chat.load(ctx);
    requestAnimationFrame(() => chat.focus());
  }
}

// ================================================================== settings

function updatesCard() {
  const r = S.release || {};
  let body;
  if (!r.checked_at) body = `<p class="note">This is Harmony ${esc(S.init?.displayVersion || '')}. Not checked yet.</p>`;
  else if (!r.ok) body = `<p class="note err">${esc(r.error || 'Could not check.')}</p>`;
  else if (r.available) {
    body = `<div class="big">${esc(r.version)} is out</div><p class="note">You have ${esc(r.installed_version)}. Harmony closes, installs it and reopens by itself.</p>`;
    if (r.notes) body += `<div class="text-view" style="max-height:160px;margin-top:8px;font-size:12px">${esc(String(r.notes).slice(0, 1500))}</div>`;
    if (r.blocked) body += `<p class="note warn">${esc(r.blocked)}</p>`;
  } else body = `<p class="note ok">You have the newest Harmony (${esc(r.installed_version || S.init?.displayVersion || '')}).</p>`;
  const actions = `<div class="row" style="margin-top:12px">${r.available ? btn(S.releaseBusy ? 'Working…' : 'Install update', `data-do="release-install"${r.can_install && !S.releaseBusy ? '' : ' disabled'}`, 'primary', 'download') : ''}${btn('Check now', `data-do="release-check"${S.releaseBusy ? ' disabled' : ''}`, 'small')}</div>`;
  const s = S.settings || {};
  const toggles = [
    setting('Check for updates', 'Looks at Harmony\'s GitHub Releases when Harmony starts and every 30 minutes.', sw(Boolean(s.auto_check_updates), 'data-do="setting" data-key="auto_check_updates"')),
    setting('Install updates automatically', 'When off, Harmony asks first. Either way, an update installs only if its signature checks out.', sw(Boolean(s.auto_install_updates), 'data-do="setting" data-key="auto_install_updates"')),
  ].join('');
  return card('Updates', body + actions + toggles, 'signed GitHub Releases');
}

const PROFILES = [
  ['potato', 'Potato', 'Least memory and CPU: images on click, no animation.'],
  ['balanced', 'Balanced', 'Comfortable everyday use.'],
  ['enthusiast', 'Enthusiast', 'Everything on, more history kept.'],
];

const choice = (key, value, options) => `<select class="field small perf-pick" data-perf="${key}">${options.map(([v, label]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
const later = '<span class="chip soon">coming soon</span>';
const mb = bytes => `${Math.round((bytes || 0) / 1048576)} MB`;

function meterLine() {
  const u = S.memory;
  if (!u) return 'Measuring…';
  if (!u.processes) return 'This system doesn\'t report memory per process.';
  return `<b>${mb(u.total_bytes)}</b> in use: core ${mb(u.core_bytes)}, window ${mb(u.window_bytes)} (${u.processes} processes)`;
}

function perfCard() {
  const s = S.settings || {};
  const p = s.perf || {};
  const current = s.profile || 'balanced';
  const picker = `<div class="seg perf-profiles">${PROFILES.map(([id, label]) => `<button class="${current === id ? 'on' : ''}" data-do="profile" data-profile="${id}" title="${esc(PROFILES.find(x => x[0] === id)[2])}">${label}</button>`).join('')}</div>`;
  const rows = [
    setting('Animations', 'Transitions and motion in the interface.', choice('motion', p.motion, [['off', 'Off'], ['short', 'Short'], ['full', 'Full']])),
    setting(`Messages kept per channel ${later}`, 'More history in memory means less waiting when you scroll back.', choice('messages_per_channel', p.messages_per_channel, [[100, '100'], [200, '200'], [300, '300']])),
    setting(`Channels kept after you leave ${later}`, 'Channels you switch back to open instantly.', choice('channels_kept', p.channels_kept, [[2, '2'], [5, '5'], [10, '10'], [20, '20'], [30, '30']])),
    setting(`Images and avatars ${later}`, '', choice('images', p.images, [['click', 'Load on click'], ['visible', 'Load when visible'], ['prefetch', 'Load nearby too']])),
    setting(`GIFs and animated emoji ${later}`, '', choice('animate', p.animate, [['hover', 'Move on hover'], ['visible', 'Move when visible'], ['always', 'Always move']])),
    setting(`Embeds and link previews ${later}`, '', sw(Boolean(p.embeds), 'data-do="perf-toggle" data-key="embeds"')),
    setting(`While minimised ${later}`, '', choice('idle', p.idle, [['stop', 'Stop drawing'], ['throttle', 'Slow down']])),
  ].join('');
  const head = `<div class="row" style="align-items:center;gap:12px;flex-wrap:wrap">${picker}${current === 'custom' ? '<span class="chip">Custom</span>' : ''}</div>
    <p class="note" style="margin-top:8px">${esc((PROFILES.find(x => x[0] === current) || ['', '', 'You changed a setting, so this is your own mix.'])[2])}</p>
    <p class="note perf-meter" style="margin-top:8px">${meterLine()}</p>`;
  return card('Performance', head + rows, 'profiles and memory');
}

/** Refresh the memory meter every 2 s while Settings is on screen. */
let meterTimer = 0;
function watchMemory(on) {
  if (!on) {
    clearInterval(meterTimer);
    meterTimer = 0;
    return;
  }
  if (meterTimer) return;
  const tick = async () => {
    if (S.view.place !== 'settings' || document.hidden) return watchMemory(false);
    S.memory = await invoke('perf_usage').catch(() => null);
    const el = document.querySelector('.perf-meter');
    if (el) el.innerHTML = meterLine();
  };
  tick();
  meterTimer = setInterval(tick, 2000);
}

/** Settings the window applies itself. */
function applyPerf() {
  document.documentElement.dataset.motion = S.settings?.perf?.motion || 'short';
}

function drawSettings() {
  setHtml(topbarEl, topbar({ ico: 'gear', title: 'Settings' }));
  const me = S.overview?.bot || {};
  showPage('settings', `<h1>Settings</h1><p class="lead">Everything saves as soon as you change it.</p>
    ${card('Account', `<div class="row" style="gap:12px;align-items:center">${avatar(me.avatar, me.name || 'You', 's40')}<div style="flex:1"><div class="big" style="font-size:16px">${esc(me.name || 'You')}</div><p class="note">${esc(me.tag || '')}</p></div>${btn('Sign out', 'data-do="logout"', 'red')}</div>
      <p class="note" style="margin-top:12px">Signing out removes your token from this PC's keychain.</p>`)}
    ${perfCard()}
    ${updatesCard()}
    ${card('Account safety', `<ul class="note" style="margin:0;padding-left:18px">
      <li>Harmony only does what you click or type. It never sends anything on its own.</li>
      <li>Sending is capped at 5 messages every 5 seconds.</li>
      <li>Each channel's history loads once when you open it, and older messages load at a limited pace.</li>
      <li>If Discord starts rejecting requests, Harmony stops making them until you restart it.</li>
      <li>Reactions, replies, edits, uploads and typing indicators each arrive in a later phase with their own limits.</li>
    </ul>`)}
    ${card('About', `<p class="note">Harmony ${esc(S.init?.displayVersion || '')}. Not affiliated with Discord.</p>`)}`);
  watchMemory(true);
}

// ================================================================== loading data

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

const timers = new Map();
function soon(key, fn, ms = 150) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, ms));
}

const online = () => S.signedIn && S.status?.state === 'online';

function loadOverview() {
  if (!online()) return Promise.resolve();
  return once('overview', async () => {
    const result = await get('/api/overview');
    if (result.ok) S.overview = result.data;
    if (S.view.place === 'guild' && S.overview && !S.overview.guilds.some(g => g.id === S.view.guildId)) S.view = { place: 'dms' };
    draw();
  });
}

function loadGuild(id) {
  if (!id || !online()) return Promise.resolve();
  return once(`guild:${id}`, async () => {
    const result = await get('/api/guild', { id });
    if (result.ok) {
      S.guilds.set(id, result.data);
      S.guildErrors.delete(id);
    } else {
      S.guildErrors.set(id, result.error);
    }
    draw();
  });
}

function loadDms() {
  if (!online()) return Promise.resolve();
  return once('dms', async () => {
    const result = await get('/api/dms');
    if (result.ok) S.dms = result.data;
    draw();
  });
}

function refreshAll() {
  loadOverview();
  loadDms();
  if (S.view.place === 'guild') loadGuild(S.view.guildId);
  if (chat.ctx && chat.root.isConnected) chat.load(chat.ctx, { force: true, quiet: true });
}

// ================================================================== navigation

function go(view) {
  closeFloat();
  if (view.place === 'guild') {
    S.lastInGuild[view.guildId] = view;
    save('lastInGuild', S.lastInGuild);
    if (view.channelId) S.unreadChannels.delete(view.channelId);
    S.unreadGuilds.delete(view.guildId);
  }
  if (view.place === 'settings') chat.saveDraft();
  if (view.place === 'dms') save('lastDm', view.userId || '');
  S.view = view;
  save('view', view);
  draw();
  if (view.place === 'guild') loadGuild(view.guildId);
  if (view.place === 'dms') loadDms();
}

const goGuild = id => go(S.lastInGuild[id] || { place: 'guild', guildId: id });

// ================================================================== actions

function saveSettings(changes) {
  S.settings = { ...S.settings, ...changes };
  applyPerf();
  draw();
  invoke('settings_set', { settings: S.settings }).then(saved => {
    S.settings = saved;
    applyPerf();
    scheduleUpdates();
    draw();
  }).catch(error => toast(String(error), 'err'));
}

function guildMenu(anchor, id = S.view.guildId) {
  menu([
    { label: 'Mark As Read', disabled: !S.unreadGuilds.has(id), run: () => { S.unreadGuilds.delete(id); draw(); } },
    'sep',
    { label: 'Copy Server ID', icon: 'copy', run: () => copy(id) },
  ], anchor.x !== undefined ? anchor : { anchor });
}

const ACTIONS = {
  login: () => signIn(),
  'login-discord': () => signInWithDiscord(),
  logout: () => signOut(),
  copy: el => copy(el.dataset.text),
  setting: el => saveSettings({ [el.dataset.key]: !S.settings[el.dataset.key] }),
  profile: el => saveSettings({ profile: el.dataset.profile }),
  'perf-toggle': el => saveSettings({ perf: { ...S.settings.perf, [el.dataset.key]: !S.settings.perf?.[el.dataset.key] } }),
  'release-check': () => checkRelease(true),
  'release-install': () => installRelease(),
  'guild-menu': el => guildMenu(el.closest('.side-head') || el),
};

// ================================================================== clicks, menus, keys

document.addEventListener('click', event => {
  const t = event.target;
  const link = t.closest('[data-href]');
  if (link) {
    event.preventDefault();
    openUrl(link.dataset.href);
    return;
  }
  const mention = t.closest('.mention[data-channel]');
  if (mention && S.view.place === 'guild') {
    const id = mention.dataset.channel;
    if (S.guilds.get(S.view.guildId)?.channels?.some(c => c.id === id)) go({ place: 'guild', guildId: S.view.guildId, channelId: id });
    return;
  }
  const doer = t.closest('[data-do]');
  if (doer && !doer.disabled && !doer.closest('.disabled')) {
    ACTIONS[doer.dataset.do]?.(doer, event);
    return;
  }
  const place = t.closest('[data-go]');
  if (place) {
    const target = place.dataset.go;
    if (target === 'dms') return go({ place: 'dms', userId: S.view.place === 'dms' ? '' : load('lastDm', '') });
    return go({ place: target });
  }
  const guild = t.closest('[data-guild]');
  if (guild) return goGuild(guild.dataset.guild);
  const cat = t.closest('[data-cat]');
  if (cat) {
    const key = cat.dataset.cat;
    if (S.collapsed.has(key)) S.collapsed.delete(key);
    else S.collapsed.add(key);
    save('collapsed', [...S.collapsed]);
    draw();
    return;
  }
  const ch = t.closest('[data-ch]');
  if (ch) return go({ place: 'guild', guildId: S.view.guildId, channelId: ch.dataset.ch });
  const dm = t.closest('[data-dm]');
  if (dm) return go({ place: 'dms', userId: dm.dataset.dm });
});

document.addEventListener('change', event => {
  const key = event.target.dataset?.perf;
  if (!key) return;
  const raw = event.target.value;
  const value = /^\d+$/.test(raw) ? Number(raw) : raw;
  saveSettings({ perf: { ...S.settings.perf, [key]: value } });
});

document.addEventListener('input', event => {
  if (event.target.dataset?.input === 'dm-search') {
    S.dmFilter = event.target.value;
    drawDmSide();
  }
});

document.addEventListener('keydown', event => {
  if (event.target.dataset?.input === 'dm-search' && event.key === 'Enter') {
    const first = dmRows()[0]?.userId;
    if (first) go({ place: 'dms', userId: first });
  }
});

// Right-click menus where Discord has them; no browser menu anywhere else.
document.addEventListener('contextmenu', event => {
  const t = event.target;
  if (t.closest('input, textarea') || window.getSelection()?.toString()) return;
  if (t.closest('.msg')) return; // the chat has its own
  event.preventDefault();
  const guild = t.closest('[data-guild]');
  if (guild) return guildMenu({ x: event.clientX, y: event.clientY }, guild.dataset.guild);
  const ch = t.closest('[data-ch]');
  if (ch && S.view.place === 'guild') {
    const gid = S.view.guildId;
    return menu([
      { label: 'Copy Channel Link', icon: 'link', run: () => copy(`https://discord.com/channels/${gid}/${ch.dataset.ch}`) },
      { label: 'Copy Channel ID', icon: 'copy', run: () => copy(ch.dataset.ch) },
    ], { x: event.clientX, y: event.clientY });
  }
  const dm = t.closest('[data-dm]');
  if (dm) {
    return menu([
      { label: 'Open', run: () => go({ place: 'dms', userId: dm.dataset.dm }) },
      { label: 'Copy User ID', icon: 'copy', run: () => copy(dm.dataset.dm) },
    ], { x: event.clientX, y: event.clientY });
  }
});

window.addEventListener('keydown', event => {
  if (event.key === 'Shift') app.shiftDown = true;
  // Ctrl+R and F5 would reload the page: harmless, but it looks like a flash.
  if (event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r')) event.preventDefault();
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    moveChannel(event.key === 'ArrowUp' ? -1 : 1);
  }
});
window.addEventListener('keyup', event => {
  if (event.key === 'Shift') app.shiftDown = false;
});
window.addEventListener('blur', () => { app.shiftDown = false; });

/** Alt+Up/Down moves through the channels or DMs like Discord. */
function moveChannel(step) {
  if (S.view.place === 'guild') {
    const detail = S.guilds.get(S.view.guildId);
    const list = groupChannels(detail?.channels || []).flatMap(([, items]) => items).filter(c => c.kind === 'text');
    const index = list.findIndex(c => c.id === S.view.channelId);
    const next = list[Math.max(0, Math.min(list.length - 1, index + step))];
    if (next) go({ place: 'guild', guildId: S.view.guildId, channelId: next.id });
  } else if (S.view.place === 'dms') {
    const list = dmRows();
    const index = list.findIndex(c => c.userId === S.view.userId);
    const next = list[Math.max(0, Math.min(list.length - 1, index + step))];
    if (next) go({ place: 'dms', userId: next.userId });
  }
}

// ================================================================== live events from the core

function chatKey(event) {
  return event.userId ? `dm:${event.userId}` : `ch:${event.channelId}`;
}

function onEvent(event) {
  switch (event.type) {
    case 'resync':
      app.chats.invalidateAll();
      refreshAll();
      break;
    case 'message': {
      const key = chatKey(event);
      const chatState = app.chats.get(key);
      if (event.op === 'delete') {
        if (chatState.loaded) app.chats.remove(key, event.id);
      } else if (event.message) {
        if (chatState.loaded) app.chats.upsert(key, event.message);
        app.typing.stop(key, event.message.authorId);
        if (event.op === 'create' && !event.message.fromBot && chat.ctx?.key !== key && event.guildId) {
          S.unreadChannels.add(event.channelId);
          if (S.view.guildId !== event.guildId || S.view.place !== 'guild') S.unreadGuilds.add(event.guildId);
          draw();
        }
      }
      break;
    }
    case 'typing':
      app.typing.add(chatKey(event), event.authorId, event.name);
      break;
    case 'guild':
      if (S.guilds.has(event.guildId) || S.view.guildId === event.guildId) soon(`g:${event.guildId}`, () => loadGuild(event.guildId), 200);
      break;
    case 'overview':
      soon('overview', loadOverview, 200);
      break;
    case 'dms':
      soon('dms', loadDms, 150);
      break;
    default:
      break;
  }
}

function onStatus(status) {
  const was = S.status?.state;
  S.status = status;
  app.live = status.state === 'online';
  if (status.state === 'online' && was !== 'online') refreshAll();
  draw();
}

// ================================================================== updates

let updateTimer = 0;
function scheduleUpdates() {
  const want = Boolean(S.settings.auto_check_updates);
  if (want && !updateTimer) {
    setTimeout(() => checkRelease(false), 10000);
    updateTimer = setInterval(() => checkRelease(false), 30 * 60 * 1000);
  } else if (!want && updateTimer) {
    clearInterval(updateTimer);
    updateTimer = 0;
  }
}

async function checkRelease(manual) {
  if (manual) toast('Checking for updates…', 'info', 2000);
  await invoke('release_check').catch(() => {});
}

let releaseAsked = '';
function onRelease(info) {
  S.release = info;
  draw();
  if (!info.available || !info.can_install || releaseAsked === info.tag) return;
  releaseAsked = info.tag;
  if (S.settings.auto_install_updates) return installRelease(true);
  if (load('releaseAsked', '') === info.tag) return;
  save('releaseAsked', info.tag);
  modal({
    title: `Harmony ${info.version} is out`,
    body: `<p>You have ${esc(info.installed_version)}. Installing takes a few seconds: Harmony closes, updates and reopens by itself.</p>${info.notes ? `<div class="text-view" style="max-height:220px">${esc(String(info.notes).slice(0, 3000))}</div>` : ''}`,
    buttons: [{ label: 'Later', kind: 'ghost' }, { label: 'Install now', kind: 'primary', run: () => { installRelease(true); } }],
  });
}

async function installRelease(sure = false) {
  const r = S.release || {};
  if (!r.can_install) return toast(r.blocked || 'No newer release to install.', 'info');
  if (!sure && !(await confirm(`Install ${r.version}`, 'Harmony closes, installs the update and reopens by itself.', { yes: 'Install', danger: false }))) return;
  S.releaseBusy = true;
  draw();
  toast('Downloading and checking the update…', 'info', 8000);
  const result = await invoke('release_install').catch(error => ({ ok: false, message: String(error) }));
  S.releaseBusy = false;
  draw();
  toast(result.message, result.ok ? 'ok' : 'err', 6000);
}

// ================================================================== start

async function start() {
  bindTooltips(document.body);
  const init = await invoke('init');
  S.init = init;
  S.signedIn = Boolean(init.signedIn);
  S.settings = init.settings || {};
  applyPerf();
  S.status = init.status || S.status;
  S.release = init.release || {};
  if (S.view.place !== 'guild' && S.view.place !== 'dms' && S.view.place !== 'settings') S.view = { place: 'dms' };

  await listen('status', onStatus);
  await listen('bot-event', onEvent);
  await listen('release', onRelease);
  await listen('auth-failed', () => {
    resetSession();
    requestAnimationFrame(() => loginError('Discord rejected your token (it changes when you change your password). Sign in again.'));
  });
  await listen('signed-in', onSignedIn);
  await listen('app-error', event => toast(event.text, 'err', 9000));

  draw();
  invoke('window_ready').catch(() => {});
  if (init.keychainError) toast(init.keychainError, 'warn', 9000);
  if (online()) refreshAll();
  scheduleUpdates();
  if (init.flags?.updated) toast(`Updated to ${init.displayVersion}.`, 'ok', 6000);
}

// Load a channel's messages while the pointer rests on it, so the click opens it at once.
sideBody.addEventListener('mouseover', debounce(event => {
  const ch = event.target.closest?.('[data-ch]');
  if (!ch || ch.dataset.kind !== 'text' || S.view.place !== 'guild') return;
  const chatState = app.chats.get(`ch:${ch.dataset.ch}`);
  if (chatState.loaded || chatState.loading) return;
  const detail = S.guilds.get(S.view.guildId);
  const c = detail?.channels?.find(x => x.id === ch.dataset.ch);
  if (c && !c.muted) chat.load(channelCtx(detail, c), { quiet: true });
}, 120));

start().catch(error => {
  document.body.insertAdjacentHTML('beforeend', `<div class="toast err" style="position:fixed;bottom:16px;left:16px">Harmony could not start: ${esc(String(error))}</div>`);
  invoke('window_ready').catch(() => {});
});
