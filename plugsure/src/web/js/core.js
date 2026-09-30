/**
 * PlugSure console core: the small framework every view is built on.
 *
 * Security rules that every view MUST follow (the console renders data a
 * charger supplies over an unauthenticated handshake — its identity, vendor
 * strings, idTags — so stored XSS is the realistic threat):
 *
 *   1. Every dynamic value interpolated into HTML goes through esc().
 *   2. Values that end up in attributes also go through esc() (it escapes
 *      quotes, apostrophes and backticks), or better, are set afterwards as a DOM
 *      property (el.dataset.x = v, el.value = v, el.textContent = v).
 *   3. CSS classes built from data come from an allow-list (tag()).
 *   4. No inline event handlers; wire events with addEventListener / on().
 */

// ------------------------------------------------------------------ escaping & DOM

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Delegated event: on(root, 'click', '[data-act="x"]', (e, el) => …). */
export function on(root, type, selector, fn) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) fn(e, el);
  });
}

/** Parse an HTML string (already escaped by the caller) into a single element. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ------------------------------------------------------------------ formatting

const nfID = new Intl.NumberFormat('id-ID');
export const fmt = {
  idr: (n) => (n == null || n === '' ? '—' : 'Rp ' + nfID.format(Math.round(Number(n)))),
  num: (n, d = 0) => (n == null || n === '' ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(Number(n))),
  kwh: (wh, d = 2) => (wh == null ? '—' : `${(Number(wh) / 1000).toFixed(d)} kWh`),
  kw: (w, d = 1) => (w == null || !Number.isFinite(Number(w)) ? '—' : `${(Number(w) / 1000).toFixed(d)} kW`),
  pct: (x, d = 0) => (x == null ? '—' : `${Number(x).toFixed(d)}%`),
  dur: (s) => {
    if (s == null) return '—';
    s = Math.max(0, Math.round(Number(s)));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  },
  time: (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
  timeS: (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false }) : '—'),
  date: (t) => (t ? new Date(t).toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' }) : '—'),
  isoDate: (t) => (t ? new Date(t).toISOString().slice(0, 10) : ''),
  ago(t) {
    if (!t) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
    if (!Number.isFinite(s)) return '—';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
  bytes: (b) => {
    if (b == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = Number(b);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
};

// ------------------------------------------------------------------ tags

const TAG_CLASSES = new Set(['t-ok', 't-info', 't-warn', 't-crit', 't-mute']);
export const tag = (cls, text, title, plain = false) =>
  `<span class="tag ${TAG_CLASSES.has(cls) ? cls : 't-mute'}${plain ? ' plain' : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

const STATUS_CLS = {
  Available: 't-ok', Charging: 't-info', Preparing: 't-warn', Finishing: 't-warn', SuspendedEV: 't-warn',
  SuspendedEVSE: 't-warn', Faulted: 't-crit', Unavailable: 't-mute', Reserved: 't-info', Occupied: 't-info',
};
export const connectorTag = (s) => tag(STATUS_CLS[s] ?? 't-mute', s ?? 'Unknown');
const TERA_CLS = { verified: 't-ok', due_soon: 't-warn', lapsed: 't-crit', unknown: 't-mute', pending: 't-crit', exempt: 't-mute' };
const TERA_LABEL = { verified: 'tera verified', due_soon: 'tera due soon', lapsed: 'tera lapsed', unknown: 'tera unknown', pending: 'pending calibration', exempt: 'tera exempt' };
export const teraTag = (t) => tag(TERA_CLS[t] ?? 't-mute', TERA_LABEL[t] ?? `tera ${t ?? 'unknown'}`);
export const onlineTag = (online, status) =>
  status === 'decommissioned' ? tag('t-mute', 'decommissioned')
  : status === 'pending_adoption' ? tag('t-warn', online ? 'connected · pending' : 'pending adoption')
  : status === 'faulted' && online ? tag('t-crit', 'faulted')
  : tag(online ? 't-ok' : 't-mute', online ? 'online' : 'offline');

// ------------------------------------------------------------------ API client

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }
/** Called when the server says the user must replace a one-time password first (e.g. reset while signed in). */
let onPasswordChangeRequired = () => {};
export function setPasswordChangeHandler(fn) { onPasswordChangeRequired = fn; }

/**
 * JSON API call. Sends the session cookie and the CSRF header the API requires
 * for cookie-authenticated writes. Throws ApiError with the server's message.
 */
export async function api(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'x-plugsure-csrf': '1', ...headers }, signal };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      opts.body = body;
      opts.headers['content-type'] ??= 'application/octet-stream';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error — is the server reachable?');
  }
  if (res.status === 401 && !path.startsWith('/v1/auth/login')) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (res.status === 403 && data?.code === 'password_change_required') onPasswordChangeRequired();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? data?.message ?? `HTTP ${res.status}`, data);
  return data;
}

/** Run an API call, toasting failures. Returns the data or null. */
export async function attempt(fn, { success, quiet = false } = {}) {
  try {
    const r = await fn();
    if (success) toast(typeof success === 'function' ? success(r) : success, 'ok');
    return r ?? true;
  } catch (e) {
    if (!quiet && e.status !== 401) toast(e.message, 'crit');
    return null;
  }
}

// ------------------------------------------------------------------ session state

export const state = {
  me: null,
  meta: null,
  sitesCache: null,
  /** Does the signed-in principal hold this permission (anywhere)? */
  can(perm) {
    return Boolean(this.me?.permissions?.includes(perm) || this.me?.permissions?.includes('platform:admin'));
  },
};

/** Site Owner portal: the signed-in user acts for a site owner (read-only, its own sites). */
export const inPortal = () => (state.me?.owners?.length ?? 0) > 0;

/** "Ibu Sari (Hotel)" → "Sari": the name to greet someone by, past an Indonesian/English honorific. */
export function greetingName(full) {
  const words = String(full ?? '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  const honorific = /^(ibu|bu|bapak|pak|bp\.?|sdr\.?|sdri\.?|mr\.?|mrs\.?|ms\.?|dr\.?|ir\.?|h\.?|hj\.?)$/i;
  return (words.find((w) => !honorific.test(w)) ?? words[0] ?? '').replace(/[,.]$/, '');
}

export async function sites(force = false) {
  if (!state.sitesCache || force) state.sitesCache = await api('/v1/sites').catch(() => []);
  return state.sitesCache;
}

// ------------------------------------------------------------------ toasts

export function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) { box = el('<div class="toasts" role="status" aria-live="polite"></div>'); document.body.append(box); }
  const t = el(`<div class="toast ${['ok', 'crit', 'warn'].includes(kind) ? kind : ''}"></div>`);
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'crit' ? 7000 : 3800);
}

// ------------------------------------------------------------------ icons

const P = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  charger: '<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3M10 7l-2 4h4l-2 4"/>',
  site: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  power: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/><path d="M4 18h2M18 18h2M12 6v2"/>',
  tariff: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  sessions: '<path d="M4 3h16v18l-3-2-3 2-3-2-3 2-4-2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  firmware: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
  bug: '<path d="M8 8a4 4 0 1 1 8 0v7a4 4 0 0 1-8 0zM4 12h4M16 12h4M5 6l3 2M19 6l-3 2M5 19l3-2M19 19l-3-2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 3.1a4 4 0 0 1 0 7.8M22 21a7 7 0 0 0-5-6.7"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8S9 3 6.5 5 9 8 12 8zM12 8s3-5 5.5-3S15 8 12 8z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  reboot: '<path d="M12 3v9"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  collapse: '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>',
  pin: '<path d="M12 22s7-6.2 7-11.5A7 7 0 0 0 5 10.5C5 15.8 12 22 12 22z" fill="currentColor"/><circle cx="12" cy="10" r="2.6" fill="#fff"/>',
  // plug standards (connector builder)
  ccs2: '<circle cx="12" cy="8" r="6"/><circle cx="9.5" cy="6.5" r="1"/><circle cx="14.5" cy="6.5" r="1"/><circle cx="12" cy="10" r="1"/><rect x="7" y="16" width="10" height="6" rx="3"/><circle cx="10" cy="19" r="1"/><circle cx="14" cy="19" r="1"/>',
  type2: '<path d="M5 6h14l2 6a9 9 0 0 1-18 0z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><circle cx="12" cy="13" r="1"/><circle cx="8.5" cy="15" r="1"/><circle cx="15.5" cy="15" r="1"/>',
  chademo: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="2"/><circle cx="16" cy="10" r="2"/><circle cx="12" cy="16" r="1.2"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/>',
  gbt: '<rect x="4" y="5" width="16" height="14" rx="4"/><circle cx="9" cy="10" r="1.6"/><circle cx="15" cy="10" r="1.6"/><circle cx="12" cy="15" r="1"/>',
};
export const icon = (name, cls = '') =>
  `<svg class="${esc(cls)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;

// ------------------------------------------------------------------ overlays

const stack = [];

/**
 * Close every open drawer and modal, top first. Called on navigation: an overlay
 * belongs to the page that opened it, and on a phone a leftover full-width drawer
 * hides the new page entirely (and a scanner modal would keep the camera on).
 */
export function closeOverlays() {
  for (const ctx of [...stack].reverse()) ctx.close();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    const top = stack[stack.length - 1];
    if (top.dismissable !== false) top.close();
  }
});

/**
 * Modal dialog.
 *   modal({ title, subtitle, body: html, size: 'lg'|'xl', actions: [{label, kind, onClick(ctx)}] })
 * onClick may return false to keep the modal open; it receives ctx {el, close, body, setBusy}.
 */
export function modal({ title, subtitle = '', body = '', size = '', actions = [{ label: 'Close' }], onMount, onClose, dismissable = true }) {
  const back = el(`<div class="backdrop" role="presentation">
    <div class="modal ${esc(size)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><div class="grow"><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button class="x" data-x aria-label="Close">${icon('x')}</button></header>
      <div class="body"></div>
      <footer></footer>
    </div></div>`);
  const bodyEl = $('.body', back);
  bodyEl.innerHTML = body;
  const foot = $('footer', back);
  const ctx = {
    el: back,
    body: bodyEl,
    close() {
      back.remove();
      const i = stack.indexOf(ctx);
      if (i >= 0) stack.splice(i, 1);
      onClose?.();
    },
    setBusy(b) { $$('footer .btn', back).forEach((x) => (x.disabled = b)); },
    dismissable,
  };
  actions.forEach((a) => {
    const b = el(`<button class="btn ${esc(a.kind ?? '')}" type="button">${esc(a.label)}</button>`);
    b.addEventListener('click', async () => {
      if (!a.onClick) return ctx.close();
      b.classList.add('busy');
      try {
        const r = await a.onClick(ctx);
        if (r !== false) ctx.close();
      } finally {
        b.classList.remove('busy');
      }
    });
    foot.append(b);
  });
  if (!actions.length) foot.remove();
  $('[data-x]', back).addEventListener('click', () => ctx.close());
  back.addEventListener('mousedown', (e) => { if (e.target === back && dismissable) ctx.close(); });
  document.body.append(back);
  stack.push(ctx);
  onMount?.(ctx);
  setTimeout(() => $('input:not([type=hidden]):not([disabled]), select, textarea', bodyEl)?.focus(), 30);
  return ctx;
}

/** Promise<boolean>. requireText forces the operator to type a phrase (destructive acts). */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title,
      body: `<p style="margin:0 0 10px">${message}</p>${
        requireText ? `<div class="field"><label>Type <b class="mono">${esc(requireText)}</b> to confirm</label><input data-confirm autocomplete="off"></div>` : ''
      }`,
      actions: [
        { label: 'Cancel' },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick(ctx) {
            if (requireText && $('[data-confirm]', ctx.body).value.trim() !== requireText) {
              $('[data-confirm]', ctx.body).classList.add('invalid');
              return false;
            }
            ok = true;
          },
        },
      ],
      onClose: () => resolve(ok),
    });
  });
}

/**
 * Side drawer with tabs — the "drawered workspace" of the spec.
 *   drawer({ title, subtitle, headerHtml, tabs: [{id, label, render(bodyEl, ctx)}], initial })
 */
export function drawer({ title, subtitle = '', headerHtml = '', tabs = [], initial, onClose }) {
  const back = el('<div class="drawer-backdrop"></div>');
  const d = el(`<aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><div class="title"><h2></h2><div class="cell-sub" data-sub></div><div data-extra></div>
        <div class="tabs" role="tablist"></div></div>
        <button class="x" data-x aria-label="Close">${icon('x')}</button></header>
      <div class="body"></div></aside>`);
  $('h2', d).textContent = title;
  $('[data-sub]', d).innerHTML = subtitle;
  $('[data-extra]', d).innerHTML = headerHtml;
  const bodyEl = $('.body', d);
  const tabBar = $('.tabs', d);
  let current = null;
  const ctx = {
    el: d,
    body: bodyEl,
    close() {
      d.remove(); back.remove();
      const i = stack.indexOf(ctx);
      if (i >= 0) stack.splice(i, 1);
      ctx.cleanup?.();
      onClose?.();
    },
    setHeader(html) { $('[data-extra]', d).innerHTML = html; },
    setSubtitle(html) { $('[data-sub]', d).innerHTML = html; },
    async show(id) {
      const t = tabs.find((x) => x.id === id) ?? tabs[0];
      if (!t) return;
      current = t.id;
      $$('button', tabBar).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t.id)));
      ctx.cleanup?.();
      ctx.cleanup = null;
      bodyEl.innerHTML = '<div class="skeleton" style="width:40%"></div>';
      try {
        await t.render(bodyEl, ctx);
      } catch (e) {
        bodyEl.innerHTML = `<div class="callout crit">${icon('warn')}<div>${esc(e.message)}</div></div>`;
      }
    },
    refresh() { return ctx.show(current); },
    get tab() { return current; },
  };
  tabs.forEach((t) => {
    const b = el(`<button role="tab" aria-selected="false">${esc(t.label)}</button>`);
    b.dataset.tab = t.id;
    b.addEventListener('click', () => ctx.show(t.id));
    tabBar.append(b);
  });
  if (tabs.length < 2) tabBar.remove();
  $('[data-x]', d).addEventListener('click', () => ctx.close());
  back.addEventListener('click', () => ctx.close());
  document.body.append(back, d);
  stack.push(ctx);
  ctx.show(initial ?? tabs[0]?.id);
  return ctx;
}

// ------------------------------------------------------------------ forms

/** Collect named inputs into an object. Numbers stay strings; the caller converts. */
export function formValues(root) {
  const out = {};
  $$('[name]', root).forEach((i) => {
    if (i.type === 'checkbox') out[i.name] = i.checked;
    else if (i.type === 'radio') { if (i.checked) out[i.name] = i.value; }
    else out[i.name] = i.value;
  });
  return out;
}

/** Show per-field errors ({field: message}); clears previous ones. */
export function fieldErrors(root, errors = {}) {
  $$('.err', root).forEach((e) => e.remove());
  $$('.invalid', root).forEach((e) => e.classList.remove('invalid'));
  for (const [k, msg] of Object.entries(errors)) {
    const input = $(`[name="${CSS.escape(k)}"]`, root);
    if (!input) continue;
    input.classList.add('invalid');
    const e = el('<div class="err"></div>');
    e.textContent = msg;
    input.closest('.field')?.append(e);
  }
  const first = $('.invalid', root);
  first?.focus();
}

export const field = (label, inner, { help = '', full = false, opt = false } = {}) =>
  `<div class="field${full ? ' full' : ''}"><label>${esc(label)}${opt ? ' <span class="opt">(optional)</span>' : ''}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;

export const options = (list, selected, { blank } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
  list.map((o) => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');

// ------------------------------------------------------------------ tables

/**
 * Render a table into `root`.
 *   columns: [{ key, label, render?(row) -> html, num?, cls?, width? }]
 *   onRow(row, tr) makes rows clickable.
 */
export function table(root, { columns, rows, empty = 'Nothing here yet.', onRow, foot }) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}"${c.width ? ` style="width:${esc(c.width)}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r, i) => `<tr data-i="${i}"${onRow ? ' class="clickable" tabindex="0"' : ''}>${columns
        .map((c) => `<td class="${c.num ? 'num ' : ''}${esc(c.cls ?? '')}">${c.render ? c.render(r, i) : esc(r[c.key] ?? '—')}</td>`)
        .join('')}</tr>`).join('')
    : `<tr><td class="empty" colspan="${columns.length}">${esc(empty)}</td></tr>`;
  root.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;
  if (onRow && rows.length) {
    $$('tbody tr', root).forEach((tr) => {
      const go = (e) => {
        if (e.target.closest('button, a, input, select, label')) return;
        onRow(rows[Number(tr.dataset.i)], tr);
      };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
    });
  }
}

// ------------------------------------------------------------------ misc helpers

export function download(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); }
  catch { toast('Copy failed — select the text and copy it manually', 'warn'); }
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function kpi(label, value, foot = '', cls = '') {
  return `<div class="card kpi ${esc(cls)}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
}

export function pageHead(title, desc = '', actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

export const callout = (kind, html) => `<div class="callout ${esc(kind)}">${icon(kind === 'ok' ? 'check' : kind === 'info' || !kind ? 'info' : 'warn')}<div>${html}</div></div>`;

// ------------------------------------------------------------------ live events

const liveSubs = new Set();
let es = null;
export function onLive(fn) { liveSubs.add(fn); return () => liveSubs.delete(fn); }
export function startLive(indicator) {
  if (es || new URLSearchParams(location.search).has('static')) return;
  es = new EventSource('/v1/stream');
  es.onopen = () => indicator?.classList.add('on');
  es.onerror = () => indicator?.classList.remove('on');
  es.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    liveSubs.forEach((fn) => { try { fn(e); } catch {} });
  };
}
export function stopLive() { es?.close(); es = null; }

// ------------------------------------------------------------------ router

/**
 * Hash router: #/<view>/<param>. Views register with registerView(id, def):
 *   def = { title, icon, group, perm, order, render(root, params) -> cleanup? }
 */
export const views = new Map();
export function registerView(id, def) { views.set(id, { id, ...def }); }
export function navigate(hash) { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); }
export function parseHash() {
  const [, view = 'dashboard', ...rest] = location.hash.replace(/^#/, '').split('/');
  return { view, params: rest.map(decodeURIComponent) };
}
