import {
  $, $$, on, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, drawer, confirmDialog, html, field,
  options, fieldErrors, toast, callout, kpi, sites as loadSites, download, copy, debounce, onLive, onlineTag,
} from '../core.js';

/**
 * Module 9 — Firmware Over-the-Air (FOTA) campaigns & the Diagnostic Log Hub.
 *
 *   9.1 Firmware repository + campaign deployment wizard + live deployment tracker
 *   9.2 Remote diagnostic log retrieval (GetDiagnostics / GetLog) + embedded log viewer
 *
 * Everything a charger reports (identity, model, firmware strings, log files) is
 * untrusted: it is escaped before it reaches the DOM, and log text is escaped
 * BEFORE search matches are wrapped in <mark>.
 */

const enc = encodeURIComponent;
const FALLBACK_STAGES = ['Initiated', 'Downloading', 'Downloaded', 'Installing', 'Installed', 'Verified'];
const stages = () => (Array.isArray(state.meta?.firmwareStages) && state.meta.firmwareStages.length === 6 ? state.meta.firmwareStages : FALLBACK_STAGES);
const canWrite = () => state.can('firmware:write');
const canDiag = () => state.can('charge_point:config') || state.can('charge_point:command');
const publicBase = () => state.me?.features?.publicBaseUrl ?? null;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TARGET_LABEL = { charge_point: 'Selected chargers', site: 'Site group', fleet: 'Entire fleet' };

// ------------------------------------------------------------------ shared helpers

const normaliseSha = (v) => String(v ?? '').trim().toLowerCase().replace(/[:\s]/g, '');
const shortSha = (s) => (s ? `${String(s).slice(0, 10)}…${String(s).slice(-6)}` : '—');

/** Same rule the server applies: a declared model must appear (case-insensitive) in the charger's model. */
function compatible(img, model) {
  const list = (img?.compatible_models ?? []).map((m) => String(m).toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const m = String(model ?? '').toLowerCase();
  return list.some((x) => m.includes(x));
}

function campaignTag(c) {
  switch (c.status) {
    case 'scheduled': return tag('t-mute', 'scheduled', 'Waiting for its first dispatch (charger online and inside the window)');
    case 'running': return tag('t-info', 'running');
    case 'completed': return Number(c.failed) ? tag('t-warn', `completed · ${c.failed} failed`) : tag('t-ok', 'completed');
    case 'cancelled': return tag('t-mute', 'cancelled');
    default: return tag('t-mute', c.status ?? 'unknown');
  }
}

const windowText = (c) =>
  c.window_start && c.window_end ? `${String(c.window_start).slice(0, 5)}–${String(c.window_end).slice(0, 5)} site time` : 'Start immediately';

/** Overall progress: verified (green) · failed (red) · in flight (blue) · queued (grey track). */
function stackbar(total, verified, failed, inflight) {
  const t = Number(total) || 0;
  const pct = (n) => (t ? Math.max(0, Math.min(100, (100 * (Number(n) || 0)) / t)) : 0).toFixed(2);
  return `<div class="stackbar" role="img" aria-label="${esc(`${verified} of ${total} verified, ${failed} failed, ${inflight} in progress`)}">
    <i style="width:${pct(verified)}%;background:var(--accent)"></i><i style="width:${pct(failed)}%;background:var(--crit)"></i><i style="width:${pct(inflight)}%;background:var(--info)"></i></div>`;
}

const JOB_EXPLAIN = {
  pending: 'Queued. Sent as soon as the charger is online, inside the window and not busy with another firmware job.',
  dispatched: 'UpdateFirmware sent. The charger will fetch the image from its download URL.',
  DownloadScheduled: 'The charger accepted the update and scheduled the download.',
  DownloadPaused: 'The charger paused the download; it resumes on its own.',
  Downloading: 'The charger is downloading the image.',
  Downloaded: 'Image stored on the charger. Most chargers install once no session is running.',
  SignatureVerified: 'The charger checked the image signature.',
  InstallScheduled: 'The charger scheduled the installation.',
  Installing: 'Flashing firmware. The charger is out of service until it reboots.',
  InstallRebooting: 'Rebooting into the new firmware.',
  Installed: 'Charger says it is installed. Waiting for it to reboot and report the new version.',
  Verified: 'Rebooted and reported the target version in BootNotification. Done.',
  failed: 'Gave up after the retry limit. "Retry failed" queues it again.',
  cancelled: 'Campaign cancelled before this charger was sent the update.',
};

function jobTag(s) {
  if (s === 'Verified') return tag('t-ok', 'verified');
  if (s === 'failed') return tag('t-crit', 'failed');
  if (s === 'cancelled') return tag('t-mute', 'cancelled');
  if (s === 'pending') return tag('t-mute', 'queued');
  return tag('t-info', s ?? 'unknown');
}

/** How far a failed job got, inferred from the error the charger reported. */
function failedStage(job) {
  const e = String(job.last_error ?? '');
  if (/InstallationFailed|InstallVerificationFailed/.test(e)) return 3;
  if (/InvalidSignature/.test(e)) return 2;
  if (/DownloadFailed/.test(e)) return 1;
  return 0;
}

function stageLabel(job) {
  if (job.state === 'failed') return 'Failed';
  if (job.state === 'cancelled') return 'Cancelled';
  const st = Number(job.stage ?? -1);
  return st >= 0 ? stages()[st] ?? job.state : 'Queued';
}

/** The 6-segment Initiated → … → Verified bar. Classes come from a fixed set only. */
function pipeline(job) {
  const names = stages();
  const failed = job.state === 'failed';
  const st = failed ? failedStage(job) : Number(job.stage ?? -1);
  const segs = names.map((n, i) => {
    let cls = '';
    if (failed) cls = i <= st ? 'done' : '';
    else if (st >= 0 && i < st) cls = 'done';
    else if (st >= 0 && i === st) cls = st === names.length - 1 ? 'done' : 'now';
    return `<i${cls ? ` class="${cls}"` : ''} title="${esc(n)}"></i>`;
  }).join('');
  return `<div class="pipeline${failed ? ' failed' : ''}" role="img" aria-label="${esc(`Stage: ${stageLabel(job)}`)}">${segs}</div>`;
}

// ------------------------------------------------------------------ 9.1 add firmware image

/** Opens the "Add firmware" modal. Resolves with the new image id, or null. */
export function openImageModal() {
  return new Promise((resolve) => {
    let mode = 'upload';
    let savedId = null;
    let controller = null;
    let timer = null;
    const vendors = state.meta?.vendors ?? [];
    const ctx = modal({
      title: 'Add firmware image',
      subtitle: 'Images in the repository can be rolled out to compatible chargers with a campaign.',
      size: 'lg',
      body: `
        <div class="seg" data-mode role="group" aria-label="Image source">
          <button type="button" data-v="upload" aria-pressed="true">Upload binary</button>
          <button type="button" data-v="url" aria-pressed="false">HTTPS download URL</button>
        </div>
        <div data-basewarn style="margin-top:10px"></div>
        <form novalidate style="margin-top:12px"><div class="form">
          <div class="field full" data-src="upload"><label>Firmware file</label><input type="file" name="file">
            <div class="help" data-filehelp>The file is streamed to this server, which computes its SHA-256 and serves it to chargers from a one-time-token URL.</div></div>
          <div class="field full" data-src="url" style="display:none"><label>HTTPS download URL</label>
            <input name="url" class="mono" inputmode="url" placeholder="https://firmware.vendor.example/hy-swifthorse/V2.4.1.bin">
            <div class="help">Chargers download directly from this address, so it must be reachable from their SIM / site network. HTTPS only.</div></div>
          ${field('Image name', '<input name="name" maxlength="200" placeholder="SwiftHorse 120 kW main controller">')}
          ${field('Version string', '<input name="version" maxlength="100" class="mono" placeholder="V2.4.1_20260801">', {
            help: 'Exactly what the charger reports as its firmware version in BootNotification after the update. PlugSure compares the two to <b>verify</b> the install, so copy it character for character.',
          })}
          ${field('Vendor', `<input name="vendor" list="fw-vendor-list" maxlength="100" placeholder="Hengyi"><datalist id="fw-vendor-list">${options(vendors)}</datalist>`, { opt: true })}
          ${field('Compatible hardware models', '<input name="compatibleModels" placeholder="HY SwiftHorse-120KW, HY SwiftHorse-60KW">', {
            full: true,
            help: 'Comma separated. Matched case-insensitively against the model each charger reports. Campaigns refuse chargers that do not match: flashing the wrong image can brick a unit. Leave blank only for vendor-wide images.',
          })}
          ${field('SHA-256 checksum', '<input name="sha256" class="mono" maxlength="100" placeholder="64 hex characters, from the vendor release notes" autocomplete="off" spellcheck="false">', {
            full: true,
            opt: true,
            help: 'Strongly recommended. For uploads the server hashes the file and <b>rejects it</b> if it does not match. For URL images, "Verify checksum" downloads the file once and compares.',
          })}
          ${field('Release notes', '<textarea name="notes" maxlength="2000" rows="3" placeholder="Fixes CCS2 pre-charge timeout; adds OCPP 1.6 SecurityEvent support"></textarea>', { full: true, opt: true })}
        </div></form>
        <div data-progress style="margin-top:12px"></div>
        <div data-err style="margin-top:12px"></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Add to repository', kind: 'primary', onClick: submit },
      ],
      onClose: () => {
        clearInterval(timer);
        controller?.abort();
        resolve(savedId);
      },
    });

    const body = ctx.body;
    const form = $('form', body);
    const val = (n) => $(`[name="${n}"]`, form).value.trim();

    const paintMode = () => {
      $$('[data-mode] button', body).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
      $$('[data-src]', form).forEach((d) => { d.style.display = d.dataset.src === mode ? '' : 'none'; });
      $('[data-basewarn]', body).innerHTML = mode === 'upload' && !publicBase()
        ? callout('warn', '<b>PUBLIC_BASE_URL is not set.</b> Chargers download uploaded images from this server, so it needs a public HTTPS address they can reach. Until an administrator sets PUBLIC_BASE_URL, campaigns using uploaded images may fail with "no download URL". Use an HTTPS URL image, or set it first.')
        : '';
      $('[data-err]', body).innerHTML = '';
    };
    on(body, 'click', '[data-mode] button', (e, b) => { mode = b.dataset.v; paintMode(); });
    paintMode();

    $('[name=file]', form).addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      const help = $('[data-filehelp]', form);
      help.textContent = f
        ? `${f.name} · ${fmt.bytes(f.size)}. The server computes the SHA-256 while it receives the file.`
        : 'The file is streamed to this server, which computes its SHA-256 and serves it to chargers from a one-time-token URL.';
    });

    async function submit(c) {
      fieldErrors(form, {});
      const err = $('[data-err]', body);
      err.innerHTML = '';
      const errs = {};
      const name = val('name');
      const version = val('version');
      const vendor = val('vendor');
      const models = val('compatibleModels').split(',').map((m) => m.trim()).filter(Boolean);
      const sha = normaliseSha($('[name=sha256]', form).value);
      const notes = $('[name=notes]', form).value.trim().slice(0, 2000);
      const file = $('[name=file]', form).files?.[0] ?? null;
      const url = val('url');
      if (!name) errs.name = 'Give the image a name';
      if (!version) errs.version = 'Enter the version string the charger will report';
      else if (version.length > 100) errs.version = 'At most 100 characters';
      if (sha && !/^[0-9a-f]{64}$/.test(sha)) errs.sha256 = 'A SHA-256 checksum is 64 hexadecimal characters';
      if (mode === 'upload') {
        if (!file) errs.file = 'Choose the firmware file';
        else if (!file.size) errs.file = 'That file is empty';
      } else if (!/^https:\/\/\S+$/i.test(url)) errs.url = 'Enter the HTTPS address of the firmware file';
      if (Object.keys(errs).length) { fieldErrors(form, errs); return false; }

      const prog = $('[data-progress]', body);
      try {
        if (mode === 'upload') {
          const qs = new URLSearchParams();
          qs.set('name', name);
          qs.set('version', version);
          if (vendor) qs.set('vendor', vendor);
          if (models.length) qs.set('compatibleModels', models.join(','));
          if (sha) qs.set('sha256', sha);
          qs.set('fileName', file.name);
          if (notes) qs.set('notes', notes);
          controller = new AbortController();
          const t0 = Date.now();
          const paint = () => {
            prog.innerHTML = `${callout('info', `<b>Uploading ${esc(file.name)}</b> (${esc(fmt.bytes(file.size))}) · ${esc(fmt.dur((Date.now() - t0) / 1000))} elapsed. The server hashes the file as it arrives${sha ? ' and compares it with your checksum' : ''}. Keep this dialog open; closing it cancels the upload.`)}
              <div class="pipeline" style="margin-top:8px"><i class="now"></i></div>`;
          };
          paint();
          timer = setInterval(paint, 1000);
          const r = await api(`/v1/firmware/images/upload?${qs}`, { method: 'POST', body: file, signal: controller.signal });
          clearInterval(timer);
          prog.innerHTML = '';
          savedId = r?.id ?? null;
          toast(`Uploaded ${fmt.bytes(r?.size ?? file.size)} · SHA-256 ${shortSha(r?.sha256)}`, 'ok');
        } else {
          const r = await api('/v1/firmware/images', {
            method: 'POST',
            body: { name, version, vendor: vendor || null, compatibleModels: models, sha256: sha || null, url, notes: notes || null },
          });
          savedId = r?.id ?? null;
          toast(sha ? 'Firmware added. Run "Verify checksum" to download and hash it once on the server.' : 'Firmware added without a checksum. Run "Verify checksum" to record one.', 'ok');
        }
      } catch (e) {
        clearInterval(timer);
        prog.innerHTML = '';
        if (e.name === 'AbortError') return false;
        err.innerHTML = callout('crit', `<b>The image was not added.</b> ${esc(e.message)}`);
        err.scrollIntoView({ block: 'nearest' });
        return false;
      }
      return undefined;
    }
  });
}

// ------------------------------------------------------------------ 9.1 campaign wizard

/** Campaign Deployment Wizard. Resolves with the new campaign id, or null. */
export async function openCampaignWizard({ imageId = null } = {}) {
  let images;
  let cps;
  let siteList;
  try {
    [images, cps, siteList] = await Promise.all([
      api('/v1/firmware/images'),
      api('/v1/charge-points').catch(() => []),
      loadSites(true),
    ]);
  } catch (e) {
    toast(e.message, 'crit');
    return null;
  }
  const usable = (images ?? []).filter((i) => !i.archived_at);
  if (!usable.length) {
    toast('Add a firmware image to the repository before creating a campaign', 'warn');
    return null;
  }
  const eligible = (cps ?? [])
    .filter((c) => !['decommissioned', 'pending_adoption'].includes(c.status))
    .sort((a, b) => String(a.ocpp_identity).localeCompare(String(b.ocpp_identity)));
  const activeSites = (siteList ?? []).filter((s) => !s.archived_at);
  const selCp = new Set();
  const selSite = new Set();
  let targetType = 'charge_point';
  let schedule = 'now';
  let nameTouched = false;
  let q = '';
  const imgById = (id) => usable.find((i) => i.id === id);

  return new Promise((resolve) => {
    let createdId = null;
    const ctx = modal({
      title: 'New firmware campaign',
      subtitle: 'Roll one image out to many chargers, inside a maintenance window, with automatic retries.',
      size: 'xl',
      body: `<form novalidate>
        <div data-err></div>
        <fieldset><legend>1 · Firmware image</legend><div class="form">
          ${field('Image', `<select name="imageId">${options(usable.map((i) => ({ value: i.id, label: `${i.name} — ${i.version}${i.vendor ? ` (${i.vendor})` : ''}` })))}</select>`)}
          ${field('Campaign name', '<input name="name" maxlength="200" placeholder="SwiftHorse V2.4.1 — Jabodetabek rollout">')}
          <div class="full" data-imginfo></div>
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>2 · Targets</legend>
          <div class="seg" data-tt role="group" aria-label="Target type">
            <button type="button" data-v="charge_point" aria-pressed="true">Individual chargers</button>
            <button type="button" data-v="site" aria-pressed="false">Site group</button>
            <button type="button" data-v="fleet" aria-pressed="false">Entire fleet</button>
          </div>
          <div data-targets style="margin-top:10px"></div>
          <div data-summary class="small" style="margin-top:10px"></div>
        </fieldset>
        <fieldset style="margin-top:14px"><legend>3 · Execution window</legend>
          <div class="seg" data-sched role="group" aria-label="Schedule">
            <button type="button" data-v="now" aria-pressed="true">Start immediately</button>
            <button type="button" data-v="window" aria-pressed="false">Maintenance window</button>
          </div>
          <div class="form" data-window style="margin-top:10px;display:none">
            ${field('Window opens', '<input type="time" name="windowStart">')}
            ${field('Window closes', '<input type="time" name="windowEnd">')}
          </div>
          <div class="hint" data-schedhint style="margin-top:8px"></div>
        </fieldset>
        <fieldset style="margin-top:14px"><legend>4 · Retry policy</legend><div class="form">
          ${field('Maximum retries', '<input type="number" name="maxRetries" min="0" max="10" step="1">', { help: '0–10. A charger gets this many extra attempts after the first.' })}
          ${field('Retry interval', '<div class="inputgroup"><input type="number" name="retryMinutes" min="1" max="1440" step="1"><span class="suffix">minutes</span></div>', { help: '1 minute to 24 hours between attempts.' })}
          <div class="full hint">A job is retried when the charger reports DownloadFailed, InstallationFailed or InvalidSignature, or goes silent (no status for 2 h after the command, or 6 h mid-download/install). After the last retry it is marked failed; you can retry failed chargers from the tracker.</div>
        </div></fieldset>
        <div style="margin-top:14px">${callout('info', `<b>What happens on each charger:</b> PlugSure sends OCPP <span class="mono">UpdateFirmware</span> with the download URL. The charger downloads the image (Downloading → Downloaded), installs it (Installing → Installed; it is out of service meanwhile, and most units wait until no session is running), then reboots. The job is only <b>Verified</b> when the charger boots and reports the image's exact version string. Offline chargers are picked up when they reconnect; only one firmware job runs per charger at a time.`)}</div>
      </form>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Create campaign', kind: 'primary', onClick: submit },
      ],
      onClose: () => resolve(createdId),
    });

    const body = ctx.body;
    const form = $('form', body);
    const sel = $('[name=imageId]', form);
    sel.value = imgById(imageId) ? imageId : usable[0].id;
    $('[name=windowStart]', form).value = '02:00';
    $('[name=windowEnd]', form).value = '04:00';
    $('[name=maxRetries]', form).value = '3';
    $('[name=retryMinutes]', form).value = '10';

    const img = () => imgById(sel.value);
    const cpById = (id) => eligible.find((c) => c.id === id);
    const targeted = () =>
      targetType === 'fleet' ? eligible
        : targetType === 'site' ? eligible.filter((c) => selSite.has(c.site_id))
          : eligible.filter((c) => selCp.has(c.id));

    const paintImage = () => {
      const i = img();
      if (!i) return;
      const models = i.compatible_models ?? [];
      let html = `<div class="row small"><span class="muted">Compatible models:</span>${
        models.length ? `<span class="chips">${models.map((m) => tag('t-info', m, null, true)).join('')}</span>` : tag('t-warn', 'any model — no compatibility guard')
      }<span class="muted" style="margin-left:10px">Checksum:</span>${
        i.sha256_verified ? tag('t-ok', 'verified', i.sha256) : i.sha256 ? tag('t-warn', 'declared, not verified') : tag('t-warn', 'none')}</div>`;
      if (!i.sha256_verified && i.source === 'url') {
        html += `<div style="margin-top:8px">${callout('warn', 'This image\'s checksum has not been verified. Run <b>Verify checksum</b> in the Firmware repository first, so a corrupted or swapped file is caught before it reaches chargers.')}</div>`;
      }
      if (i.source === 'upload' && !publicBase()) {
        html += `<div style="margin-top:8px">${callout('warn', '<b>PUBLIC_BASE_URL is not set.</b> This is an uploaded image, and chargers need a public address to download it from. Dispatches outside this request may fail with "no download URL" until an administrator sets it.')}</div>`;
      }
      $('[data-imginfo]', form).innerHTML = html;
      if (!nameTouched) $('[name=name]', form).value = `${i.name} ${i.version} rollout`;
    };

    const paintSummary = () => {
      const t = targeted();
      const i = img();
      const bad = t.filter((c) => !compatible(i, c.model));
      const online = t.filter((c) => c.online).length;
      let html = t.length
        ? `<b>${esc(plural(t.length, 'charger'))}</b> targeted · ${esc(online)} online now${t.length - online ? ` · ${esc(t.length - online)} offline (updated when they reconnect)` : ''}`
        : '<span class="muted">No chargers targeted yet.</span>';
      if (bad.length) {
        html += `<div style="margin-top:8px">${callout('crit', `<b>${esc(plural(bad.length, 'target'))} not compatible with this image.</b> The server will refuse the campaign: ${esc(bad.slice(0, 5).map((c) => `${c.ocpp_identity} (${c.model ?? 'unknown model'})`).join(', '))}${bad.length > 5 ? '…' : ''}`)}</div>`;
      }
      $('[data-summary]', form).innerHTML = html;
    };

    const paintList = () => {
      const i = img();
      const box = $('[data-targets]', form);
      if (targetType === 'charge_point') {
        for (const id of [...selCp]) { const c = cpById(id); if (!c || !compatible(i, c.model)) selCp.delete(id); }
        const needle = q.toLowerCase();
        const shown = eligible.filter((c) => !needle || [c.ocpp_identity, c.display_name, c.model, c.vendor, c.site_name].some((x) => String(x ?? '').toLowerCase().includes(needle)));
        $('[data-cplist]', box).innerHTML = shown.length
          ? shown.map((c) => {
            const ok = compatible(i, c.model);
            return `<label class="check" style="padding:7px 10px;border-bottom:1px solid var(--line);align-items:center">
              <input type="checkbox" data-cp="${esc(c.id)}"${selCp.has(c.id) ? ' checked' : ''}${ok ? '' : ' disabled'}>
              <span class="grow"><span class="mono">${esc(c.ocpp_identity)}</span>${c.display_name ? ` <span class="muted">· ${esc(c.display_name)}</span>` : ''}
                <span class="cell-sub" style="display:block">${esc(c.model ?? 'unknown model')} · ${esc(c.site_name ?? '—')} · firmware <span class="mono">${esc(c.firmware ?? '—')}</span></span></span>
              ${ok ? '' : tag('t-crit', 'incompatible model', 'This model is not in the image\'s compatible models')}
              ${onlineTag(c.online, c.status)}</label>`;
          }).join('')
          : `<div class="empty-state small">${eligible.length ? 'No chargers match the filter.' : 'No commissioned chargers in this organisation.'}</div>`;
      } else if (targetType === 'site') {
        $('[data-sitelist]', box).innerHTML = activeSites.length
          ? activeSites.map((s) => {
            const here = eligible.filter((c) => c.site_id === s.id);
            const bad = here.filter((c) => !compatible(i, c.model)).length;
            return `<label class="check" style="padding:7px 10px;border-bottom:1px solid var(--line);align-items:center">
              <input type="checkbox" data-site="${esc(s.id)}"${selSite.has(s.id) ? ' checked' : ''}${here.length ? '' : ' disabled'}>
              <span class="grow"><b>${esc(s.name)}</b><span class="cell-sub" style="display:block">${esc(plural(here.length, 'charger'))} · ${esc(here.filter((c) => c.online).length)} online · ${esc(s.timezone ?? 'Asia/Jakarta')}</span></span>
              ${bad ? tag('t-crit', `${bad} incompatible`) : here.length ? tag('t-ok', 'all compatible') : tag('t-mute', 'no chargers')}</label>`;
          }).join('')
          : '<div class="empty-state small">No sites yet.</div>';
      } else {
        const bad = eligible.filter((c) => !compatible(i, c.model)).length;
        box.innerHTML = callout(bad ? 'warn' : 'info', `Every commissioned charger in the organisation: <b>${esc(plural(eligible.length, 'charger'))}</b> across ${esc(plural(new Set(eligible.map((c) => c.site_id)).size, 'site'))}. Decommissioned and pending-adoption units are skipped.${
          bad ? ` <b>${esc(bad)}</b> of them are not a compatible model, so the server will refuse a fleet-wide campaign for this image; target sites or chargers instead.` : ''}`);
      }
      paintSummary();
    };

    const paintTargets = () => {
      $$('[data-tt] button', form).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === targetType)));
      const box = $('[data-targets]', form);
      const listStyle = 'max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px';
      if (targetType === 'charge_point') {
        box.innerHTML = `<div class="row" style="margin-bottom:8px"><input type="search" data-q placeholder="Filter by identity, name, model or site" style="flex:1;min-width:220px">
          <button type="button" class="btn sm" data-all>Select all compatible shown</button><button type="button" class="btn sm ghost" data-none>Clear</button></div>
          <div data-cplist style="${listStyle}"></div>`;
        $('[data-q]', box).value = q;
      } else if (targetType === 'site') {
        box.innerHTML = `<div class="row" style="margin-bottom:8px"><span class="hint">Every commissioned charger at the chosen sites, including ones added before the campaign starts dispatching.</span>
          <button type="button" class="btn sm ghost right" data-none>Clear</button></div><div data-sitelist style="${listStyle}"></div>`;
      }
      paintList();
    };

    const paintSchedule = () => {
      $$('[data-sched] button', form).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === schedule)));
      $('[data-window]', form).style.display = schedule === 'window' ? '' : 'none';
      $('[data-schedhint]', form).textContent = schedule === 'window'
        ? 'Chargers are only sent the update between these times, in each site\'s own time zone (WIB / WITA / WIT). A window may cross midnight, e.g. 23:00–02:00. An update already in progress when the window closes is allowed to finish; chargers not reached wait for the next night.'
        : 'Chargers are sent the update as soon as the campaign is created (online ones immediately, offline ones when they reconnect). Use a window to avoid taking chargers out of service at busy times.';
    };

    on(form, 'click', '[data-tt] button', (e, b) => { targetType = b.dataset.v; paintTargets(); });
    on(form, 'click', '[data-sched] button', (e, b) => { schedule = b.dataset.v; paintSchedule(); });
    on(form, 'input', '[data-q]', (e, i) => { q = i.value; paintList(); });
    on(form, 'change', '[data-cp]', (e, i) => { if (i.checked) selCp.add(i.dataset.cp); else selCp.delete(i.dataset.cp); paintSummary(); });
    on(form, 'change', '[data-site]', (e, i) => { if (i.checked) selSite.add(i.dataset.site); else selSite.delete(i.dataset.site); paintSummary(); });
    on(form, 'click', '[data-all]', () => {
      $$('[data-cp]', form).forEach((i) => { if (!i.disabled) selCp.add(i.dataset.cp); });
      paintList();
    });
    on(form, 'click', '[data-none]', () => { (targetType === 'site' ? selSite : selCp).clear(); paintList(); });
    sel.addEventListener('change', () => { paintImage(); paintList(); });
    $('[name=name]', form).addEventListener('input', () => { nameTouched = true; });

    paintImage();
    paintTargets();
    paintSchedule();

    async function submit() {
      fieldErrors(form, {});
      const err = $('[data-err]', form);
      err.innerHTML = '';
      const errs = {};
      const i = img();
      const name = $('[name=name]', form).value.trim();
      if (!i) errs.imageId = 'Choose a firmware image';
      if (!name) errs.name = 'Give the campaign a name';
      let windowStart = null;
      let windowEnd = null;
      if (schedule === 'window') {
        windowStart = $('[name=windowStart]', form).value.slice(0, 5);
        windowEnd = $('[name=windowEnd]', form).value.slice(0, 5);
        if (!HHMM.test(windowStart)) errs.windowStart = 'Enter the opening time (HH:MM)';
        if (!HHMM.test(windowEnd)) errs.windowEnd = 'Enter the closing time (HH:MM)';
        else if (windowStart === windowEnd) errs.windowEnd = 'Opening and closing times cannot be the same';
      }
      const maxRetries = Number($('[name=maxRetries]', form).value);
      if ($('[name=maxRetries]', form).value === '' || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) errs.maxRetries = 'A whole number from 0 to 10';
      const minutes = Number($('[name=retryMinutes]', form).value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) errs.retryMinutes = 'A whole number of minutes, 1 to 1440';
      const ids = targetType === 'charge_point' ? [...selCp] : targetType === 'site' ? [...selSite] : [];
      const targetProblem = targetType !== 'fleet' && !ids.length
        ? (targetType === 'site' ? 'Select at least one site.' : 'Select at least one charger.')
        : !targeted().length ? 'No commissioned chargers match these targets.' : null;
      if (targetProblem) err.innerHTML = `<div style="margin-bottom:12px">${callout('crit', esc(targetProblem))}</div>`;
      if (Object.keys(errs).length || targetProblem) {
        fieldErrors(form, errs);
        if (targetProblem && !Object.keys(errs).length) err.scrollIntoView({ block: 'nearest' });
        return false;
      }
      try {
        const r = await api('/v1/firmware/campaigns', {
          method: 'POST',
          body: { imageId: i.id, name, targetType, targetIds: ids, windowStart, windowEnd, maxRetries, retryIntervalS: minutes * 60 },
        });
        createdId = r?.id ?? null;
        toast(`Campaign created for ${plural(Number(r?.targets ?? targeted().length), 'charger')}${
          schedule === 'window' ? ` · dispatch waits for ${windowStart}–${windowEnd} site time` : ' · dispatch has started'}`, 'ok');
      } catch (e) {
        const problems = Array.isArray(e.data?.problems) ? e.data.problems : [];
        err.innerHTML = `<div style="margin-bottom:12px">${callout('crit', `<b>The campaign was not created.</b> ${esc(e.message)}${
          problems.length > 1 ? `<ul style="margin:6px 0 0;padding-left:18px">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}`)}</div>`;
        err.scrollIntoView({ block: 'nearest' });
        return false;
      }
      return undefined;
    }
  });
}

// ------------------------------------------------------------------ 9.1 live deployment tracker

export function openTracker(campaignId, { onClose } = {}) {
  let filter = 'all';
  let search = '';
  return drawer({
    title: 'Live Deployment Tracker',
    onClose,
    tabs: [{
      id: 'jobs',
      label: 'Chargers',
      async render(body, ctx) {
        body.innerHTML = `<div data-top></div>
          <div class="section">
            <div class="row" style="margin-bottom:10px">
              <div class="seg" data-filter role="group" aria-label="Filter chargers">
                <button type="button" data-v="all" aria-pressed="true">All</button>
                <button type="button" data-v="active" aria-pressed="false">In progress</button>
                <button type="button" data-v="pending" aria-pressed="false">Queued</button>
                <button type="button" data-v="failed" aria-pressed="false">Failed</button>
                <button type="button" data-v="Verified" aria-pressed="false">Verified</button>
              </div>
              <input type="search" data-search placeholder="Find charger or site" style="min-width:200px">
              <span class="small muted right" data-status></span>
            </div>
            <div class="card" data-jobs></div>
          </div>`;
        let last = null;
        let busy = false;
        let lastErr = '';

        const matches = (j) => {
          if (filter === 'active' && (['pending', 'failed', 'cancelled', 'Verified'].includes(j.state))) return false;
          if (filter === 'pending' && j.state !== 'pending') return false;
          if (filter === 'failed' && j.state !== 'failed') return false;
          if (filter === 'Verified' && j.state !== 'Verified') return false;
          const n = search.toLowerCase();
          return !n || [j.ocpp_identity, j.site_name, j.model].some((x) => String(x ?? '').toLowerCase().includes(n));
        };

        const paint = () => {
          if (!last) return;
          const c = last.campaign ?? {};
          const jobs = last.jobs ?? [];
          const total = jobs.length;
          const verified = jobs.filter((j) => j.state === 'Verified').length;
          const failed = jobs.filter((j) => j.state === 'failed').length;
          const pending = jobs.filter((j) => j.state === 'pending').length;
          const cancelled = jobs.filter((j) => j.state === 'cancelled').length;
          const inflight = total - verified - failed - pending - cancelled;
          const active = ['scheduled', 'running'].includes(c.status);
          ctx.setSubtitle(`${esc(c.name ?? '')} · ${esc(c.image_name ?? '')} <span class="mono">${esc(c.image_version ?? '')}</span> · ${campaignTag({ ...c, failed })}`);

          $('[data-top]', body).innerHTML = `
            <div class="row" style="margin-bottom:14px">
              ${canWrite() && active ? `<button type="button" class="btn" data-act="cancel">${icon('stop')} Cancel campaign</button>` : ''}
              ${canWrite() && failed && c.status !== 'cancelled' ? `<button type="button" class="btn primary" data-act="retry">${icon('refresh')} Retry failed (${esc(failed)})</button>` : ''}
              <button type="button" class="btn ghost" data-act="refresh">${icon('refresh')} Refresh</button>
            </div>
            <div class="grid k4">
              ${kpi('Verified', `${esc(verified)}<span class="muted" style="font-size:15px"> / ${esc(total)}</span>`, total ? `${Math.round((100 * verified) / total)}% on the target version` : 'no chargers', verified === total && total ? 'ok' : '')}
              ${kpi('In progress', esc(inflight), 'downloading, installing or awaiting reboot')}
              ${kpi('Queued', esc(pending), c.window_start ? `waiting for ${esc(windowText(c))} or the charger` : 'waiting for the charger to be online')}
              ${kpi('Failed', esc(failed), failed ? 'retry limit reached' : cancelled ? `${esc(cancelled)} cancelled` : 'none', failed ? 'crit' : '')}
            </div>
            <div style="margin-top:12px">${stackbar(total, verified, failed, inflight)}
              <div class="legend"><span style="--c:var(--accent)">Verified</span><span style="--c:var(--crit)">Failed</span><span style="--c:var(--info)">In progress</span><span style="--c:var(--bg-2)">Queued / cancelled</span></div></div>
            <div class="grid two" style="margin-top:14px">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Campaign</h3><dl class="kv">
                <dt>Image</dt><dd>${esc(c.image_name ?? '—')} · <span class="mono">${esc(c.image_version ?? '—')}</span></dd>
                <dt>Targets</dt><dd>${esc(TARGET_LABEL[c.target_type] ?? c.target_type ?? '—')} · ${esc(plural(total, 'charger'))}</dd>
                <dt>Window</dt><dd>${esc(windowText(c))}</dd>
                <dt>Retry policy</dt><dd>${esc(plural(Number(c.max_retries ?? 0), 'retry', 'retries'))}, ${esc(fmt.dur(c.retry_interval_s))} apart</dd>
                <dt>Created</dt><dd>${esc(fmt.time(c.created_at))}</dd>
                <dt>Finished</dt><dd>${c.completed_at ? esc(fmt.time(c.completed_at)) : '—'}</dd>
              </dl></div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">How to read the pipeline</h3>
                <ol class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px">
                  <li><b>Initiated</b> — UpdateFirmware sent and accepted.</li>
                  <li><b>Downloading / Downloaded</b> — the charger fetches and stores the image.</li>
                  <li><b>Installing / Installed</b> — flashing; the charger is out of service.</li>
                  <li><b>Verified</b> — after rebooting it reported <span class="mono">${esc(c.image_version ?? '')}</span> in BootNotification.</li>
                </ol>
                <div class="hint" style="margin-top:6px">The pulsing segment is where the charger is now; red means it failed at that step.</div></div>
            </div>`;

          const counts = { all: total, active: inflight, pending, failed, Verified: verified };
          const labels = { all: 'All', active: 'In progress', pending: 'Queued', failed: 'Failed', Verified: 'Verified' };
          $$('[data-filter] button', body).forEach((b) => {
            b.textContent = `${labels[b.dataset.v]} (${counts[b.dataset.v] ?? 0})`;
            b.setAttribute('aria-pressed', String(b.dataset.v === filter));
          });
          $('[data-status]', body).innerHTML = `<span class="live-dot${active ? ' on' : ''}"></span> ${active ? 'Live' : 'Final'} · updated ${esc(fmt.timeS(Date.now()))}${lastErr ? ` · <span style="color:var(--crit)">${esc(lastErr)}</span>` : ''}`;

          const target = String(c.image_version ?? '').trim();
          table($('[data-jobs]', body), {
            columns: [
              {
                label: 'Charger',
                render: (j) => `<div class="cell-title nowrap"><span class="live-dot${j.online ? ' on' : ''}" title="${j.online ? 'online' : 'offline'}"></span> <span class="mono">${esc(j.ocpp_identity)}</span></div>
                  <div class="cell-sub">${esc(j.site_name ?? '—')}</div><div class="cell-sub">${esc(j.model ?? 'unknown model')}</div>`,
              },
              {
                label: 'Progress',
                width: '34%',
                render: (j) => `${pipeline(j)}<div class="cell-sub wrap" style="margin-top:5px"><b>${esc(stageLabel(j))}</b> — ${esc(JOB_EXPLAIN[j.state] ?? `charger reported ${j.state}`)}</div>`,
              },
              { label: 'State', render: (j) => jobTag(j.state) },
              { label: 'Attempts', num: true, render: (j) => `${esc(j.attempts ?? 0)} / ${esc(Number(c.max_retries ?? 0) + 1)}` },
              {
                label: 'Firmware',
                render: (j) => `<div class="mono small wrap">${esc(j.firmware_before ?? '—')} → ${esc(j.firmware_now ?? '—')}</div>${
                  target && String(j.firmware_now ?? '').trim() === target ? tag('t-ok', 'on target') : ''}`,
              },
              {
                label: 'Last error / next step',
                render: (j) => {
                  const errTxt = j.last_error ? `<div class="small wrap" style="color:var(--crit)">${esc(j.last_error)}</div>` : '';
                  let next = '';
                  if (j.state === 'pending' && c.status !== 'cancelled') {
                    const due = j.next_attempt_at ? new Date(j.next_attempt_at).getTime() : 0;
                    next = due > Date.now()
                      ? `<div class="cell-sub">retry ${esc(fmt.time(j.next_attempt_at))}</div>`
                      : `<div class="cell-sub">${j.online ? 'due; waiting for the window or a free slot' : 'waiting for the charger to come online'}</div>`;
                  }
                  return errTxt + next || '<span class="muted">—</span>';
                },
              },
              { label: 'Updated', render: (j) => `<span class="small nowrap" title="${esc(fmt.time(j.updated_at))}">${esc(fmt.ago(j.updated_at))}</span>` },
            ],
            rows: jobs.filter(matches),
            empty: jobs.length ? 'No chargers match this filter.' : 'This campaign has no chargers.',
          });
        };

        const draw = async () => {
          if (busy) return;
          busy = true;
          try {
            last = await api(`/v1/firmware/campaigns/${enc(campaignId)}`);
            lastErr = '';
          } catch (e) {
            if (!last) throw e;
            lastErr = `refresh failed: ${e.message}`;
          } finally {
            busy = false;
          }
          paint();
        };

        await draw();

        on(body, 'click', '[data-filter] button', (e, b) => { filter = b.dataset.v; paint(); });
        on(body, 'input', '[data-search]', debounce((e) => { search = e.target.value.trim(); paint(); }, 150));
        on(body, 'click', '[data-act]', async (e, b) => {
          const c = last?.campaign ?? {};
          const jobs = last?.jobs ?? [];
          if (b.dataset.act === 'refresh') { await draw().catch(() => {}); return; }
          if (b.dataset.act === 'cancel') {
            const queued = jobs.filter((j) => j.state === 'pending').length;
            const moving = jobs.filter((j) => !['pending', 'failed', 'cancelled', 'Verified'].includes(j.state)).length;
            const ok = await confirmDialog({
              title: 'Cancel this campaign?',
              message: html`<b>${queued}</b> queued ${queued === 1 ? 'charger' : 'chargers'} will not be sent the update. <b>${moving}</b> ${moving === 1 ? 'charger is' : 'chargers are'} already downloading or installing; that cannot be stopped remotely, so they finish on their own and their status keeps updating here.`,
              confirmLabel: 'Cancel campaign',
              danger: true,
            });
            if (!ok) return;
            b.classList.add('busy');
            await attempt(() => api(`/v1/firmware/campaigns/${enc(c.id ?? campaignId)}/cancel`, { method: 'POST' }), { success: 'Campaign cancelled' });
            await draw().catch(() => {});
          }
          if (b.dataset.act === 'retry') {
            b.classList.add('busy');
            await attempt(() => api(`/v1/firmware/campaigns/${enc(c.id ?? campaignId)}/retry-failed`, { method: 'POST' }), {
              success: (r) => `${plural(Number(r?.retried ?? 0), 'charger')} queued again with a fresh retry budget`,
            });
            await draw().catch(() => {});
          }
        });

        const t = setInterval(() => { draw().catch(() => {}); }, 5000);
        const off = onLive((e) => { if (e.kind === 'firmware.status') draw().catch(() => {}); });
        ctx.cleanup = () => { clearInterval(t); off(); };
      },
    }],
  });
}

// ------------------------------------------------------------------ tab: campaigns

async function renderCampaigns(pane, app, openId) {
  pane.innerHTML = '<div class="grid k4" data-kpis></div><div class="card section" data-list></div>';
  const draw = async () => {
    const list = await api('/v1/firmware/campaigns');
    if (!app.alive()) return;
    const live = list.filter((c) => ['scheduled', 'running'].includes(c.status));
    const inflight = (c) => Math.max(0, Number(c.jobs) - Number(c.verified) - Number(c.failed) - Number(c.pending));
    const sum = (arr, f) => arr.reduce((a, c) => a + (Number(f(c)) || 0), 0);
    const failedLive = sum(list.filter((c) => c.status !== 'cancelled'), (c) => c.failed);
    $('[data-kpis]', pane).innerHTML = [
      kpi('Active campaigns', fmt.num(live.length), `${fmt.num(list.length)} in total`),
      kpi('Chargers updating', fmt.num(sum(live, inflight)), `${fmt.num(sum(live, (c) => c.pending))} queued`),
      kpi('Verified updates', fmt.num(sum(list, (c) => c.verified)), 'confirmed by BootNotification', 'ok'),
      kpi('Failed jobs', fmt.num(failedLive), failedLive ? 'open a campaign to retry' : 'none outstanding', failedLive ? 'crit' : ''),
    ].join('');
    table($('[data-list]', pane), {
      columns: [
        { label: 'Campaign', render: (c) => `<div class="cell-title">${esc(c.name)}</div><div class="cell-sub">${esc(fmt.time(c.created_at))}</div>` },
        { label: 'Status', render: (c) => campaignTag(c) },
        { label: 'Image', render: (c) => `<div>${esc(c.image_name)}</div><div class="cell-sub mono">${esc(c.image_version)}</div>` },
        { label: 'Targets', render: (c) => `${esc(TARGET_LABEL[c.target_type] ?? c.target_type)}<div class="cell-sub">${esc(windowText(c))}</div>` },
        { label: 'Chargers', num: true, render: (c) => esc(c.jobs) },
        {
          label: 'Progress',
          width: '26%',
          render: (c) => `${stackbar(c.jobs, c.verified, c.failed, inflight(c))}
            <div class="cell-sub" style="margin-top:4px">${esc(c.verified)}/${esc(c.jobs)} verified · ${esc(inflight(c))} ${c.status === 'cancelled' ? 'in progress / cancelled' : 'in progress'} · ${esc(c.pending)} queued${Number(c.failed) ? ` · <b style="color:var(--crit)">${esc(c.failed)} failed</b>` : ''}</div>`,
        },
      ],
      rows: list,
      empty: 'No campaigns yet. Add an image to the Firmware repository, then create a campaign to roll it out.',
      onRow: (c) => openTracker(c.id, { onClose: () => { if (app.alive()) draw().catch(() => {}); } }),
    });
  };
  await draw();
  if (openId) openTracker(openId, { onClose: () => { if (app.alive()) draw().catch(() => {}); } });
  const redraw = debounce(() => { if (app.alive()) draw().catch(() => {}); }, 800);
  const off = onLive((e) => { if (e.kind === 'firmware.status') redraw(); });
  const t = setInterval(() => { if (document.visibilityState === 'visible') redraw(); }, 30000);
  return () => { off(); clearInterval(t); };
}

// ------------------------------------------------------------------ tab: repository

async function renderImages(pane, app) {
  let showArchived = false;
  let rows = [];
  pane.innerHTML = `${!publicBase() ? `<div style="margin-bottom:12px">${callout('warn', '<b>PUBLIC_BASE_URL is not set.</b> Uploaded images are served to chargers by this server, so chargers need a public HTTPS address to download them. Ask an administrator to set PUBLIC_BASE_URL, or add images by HTTPS URL.')}</div>` : ''}
    <div class="row" style="margin-bottom:10px"><label class="check"><input type="checkbox" data-arch> Show archived images</label>
      <span class="hint right">Compatible models are enforced: a campaign refuses chargers whose model does not match.</span></div>
    <div class="card" data-list></div>`;
  const listEl = $('[data-list]', pane);

  const draw = async () => {
    const all = await api('/v1/firmware/images');
    if (!app.alive()) return;
    rows = all.filter((i) => showArchived || !i.archived_at);
    const w = canWrite();
    table(listEl, {
      columns: [
        {
          label: 'Image',
          render: (i) => `<div class="cell-title">${esc(i.name)} ${i.archived_at ? tag('t-mute', 'archived') : ''}</div>${i.notes ? `<div class="cell-sub wrap">${esc(String(i.notes).slice(0, 140))}</div>` : ''}`,
        },
        { label: 'Version', render: (i) => `<span class="mono">${esc(i.version)}</span>` },
        { label: 'Vendor', render: (i) => esc(i.vendor ?? '—') },
        {
          label: 'Compatible models',
          render: (i) => ((i.compatible_models ?? []).length
            ? `<div class="chips">${i.compatible_models.map((m) => tag('t-info', m, null, true)).join('')}</div>`
            : tag('t-warn', 'any model', 'No compatibility guard for this image')),
        },
        {
          label: 'Source',
          render: (i) => (i.source === 'upload'
            ? `${tag('t-mute', 'upload', null, true)}<div class="cell-sub mono">${esc(i.file_name ?? '')}</div>`
            : `${tag('t-mute', 'url', null, true)}<div class="cell-sub mono wrap" title="${esc(i.url ?? '')}">${esc(String(i.url ?? '').replace(/^https:\/\//i, '').slice(0, 48))}${String(i.url ?? '').length > 56 ? '…' : ''}</div>`),
        },
        { label: 'Size', num: true, render: (i) => esc(fmt.bytes(i.size_bytes)) },
        {
          label: 'SHA-256',
          render: (i) => `<div class="row nowrap" style="gap:4px"><span class="mono small" title="${esc(i.sha256 ?? '')}">${esc(shortSha(i.sha256))}</span>${
            i.sha256 ? `<button type="button" class="btn sm ghost icon" data-act="copy" data-i="${rows.indexOf(i)}" title="Copy full checksum" aria-label="Copy checksum">${icon('copy')}</button>` : ''}</div>
            ${i.sha256_verified ? tag('t-ok', 'verified') : i.sha256 ? tag('t-warn', 'not verified') : tag('t-mute', 'no checksum')}`,
        },
        { label: 'Campaigns', num: true, render: (i) => esc(i.campaigns ?? 0) },
        { label: 'Added', render: (i) => `<span class="small nowrap">${esc(fmt.time(i.created_at))}</span>` },
        {
          label: '',
          render: (i, idx) => (i.archived_at ? '' : `<div class="row nowrap" style="gap:4px;justify-content:flex-end">
            ${w ? `<button type="button" class="btn sm" data-act="deploy" data-i="${idx}">${icon('play')} Deploy</button>` : ''}
            ${w && i.source === 'url' ? `<button type="button" class="btn sm" data-act="verify" data-i="${idx}" title="Download the file once on the server and hash it">${icon('shield')} Verify checksum</button>` : ''}
            ${w ? `<button type="button" class="btn sm ghost" data-act="archive" data-i="${idx}">Archive</button>` : ''}</div>`),
        },
      ],
      rows,
      empty: showArchived ? 'The repository is empty.' : 'No firmware images yet. Use "Add firmware" to upload a binary or register an HTTPS download URL.',
    });
  };

  $('[data-arch]', pane).addEventListener('change', (e) => { showArchived = e.target.checked; draw().catch((err) => toast(err.message, 'crit')); });
  on(listEl, 'click', '[data-act]', async (e, b) => {
    const i = rows[Number(b.dataset.i)];
    if (!i) return;
    if (b.dataset.act === 'copy') return copy(i.sha256);
    if (b.dataset.act === 'deploy') {
      const id = await openCampaignWizard({ imageId: i.id });
      if (id) app.goto('campaigns', id);
      return;
    }
    if (b.dataset.act === 'verify') {
      toast('Downloading the image on the server to hash it; large files can take a few minutes…');
      b.classList.add('busy');
      await attempt(() => api(`/v1/firmware/images/${enc(i.id)}/verify`, { method: 'POST' }), {
        success: (r) => `Checksum verified · ${fmt.bytes(r?.size)} · SHA-256 ${shortSha(r?.sha256)}`,
      });
      b.classList.remove('busy');
      if (app.alive()) await draw().catch(() => {});
      return;
    }
    if (b.dataset.act === 'archive') {
      const ok = await confirmDialog({
        title: 'Archive firmware image?',
        message: html`<b>${i.name}</b> <span class="mono">${i.version}</span> will no longer be offered for new campaigns${
          i.source === 'upload' ? ', and this server stops serving the file to chargers: any campaign still dispatching it will fail its remaining downloads' : ''}. The record and its campaign history are kept.`,
        confirmLabel: 'Archive image',
        danger: true,
      });
      if (!ok) return;
      await attempt(() => api(`/v1/firmware/images/${enc(i.id)}/archive`, { method: 'POST' }), { success: 'Image archived' });
      if (app.alive()) await draw().catch(() => {});
    }
  });
  await draw();
  return app.onImageAdded(() => draw().catch(() => {}));
}

// ------------------------------------------------------------------ 9.2 diagnostics

const DIAG = {
  Requested: ['t-info', 'requested', 'Command accepted; waiting for the charger to start uploading.'],
  Uploading: ['t-info', 'uploading', 'The charger is uploading its logs.'],
  Uploaded: ['t-ok', 'uploaded', 'The charger reports the upload finished.'],
  UploadFailed: ['t-crit', 'upload failed', 'The charger could not upload (network, credentials or permissions on the target).'],
  Rejected: ['t-crit', 'rejected', 'The charger refused the request or did not answer.'],
  Idle: ['t-mute', 'idle', 'The charger reports it is not uploading.'],
};
const diagTag = (s) => tag(DIAG[s]?.[0] ?? 't-mute', DIAG[s]?.[1] ?? s ?? 'unknown');
/** Hide credentials a custom FTP URL may carry. */
const maskLocation = (s) => String(s ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1•••@');
const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function downloadDiag(row) {
  const res = await attempt(() => api(`/v1/diagnostics/${enc(row.id)}/download`, { raw: true }));
  if (!res || res === true) return;
  try {
    download(row.file_name || `diagnostics-${row.ocpp_identity ?? 'charger'}.log`, await res.blob());
  } catch (e) {
    toast(`Download failed: ${e.message}`, 'crit');
  }
}

/** "Request logs" modal. Resolves true when the charger accepted the request. */
function openDiagRequest(cp) {
  return new Promise((resolve) => {
    let ok = false;
    let target = 'builtin';
    const ctx = modal({
      title: `Request diagnostic logs — ${cp.ocpp_identity}`,
      subtitle: 'Sends OCPP GetDiagnostics (GetLog on OCPP 2.0.1). The charger gathers its logs and uploads them itself, usually within a few minutes.',
      size: 'lg',
      body: `<form novalidate><div data-err></div>
        <fieldset><legend>Log period</legend>
          <div class="seg" data-range role="group" aria-label="Quick range" style="margin-bottom:10px">
            <button type="button" data-h="1" aria-pressed="false">Last hour</button>
            <button type="button" data-h="24" aria-pressed="true">Last 24 h</button>
            <button type="button" data-h="168" aria-pressed="false">Last 7 days</button>
            <button type="button" data-h="0" aria-pressed="false">Everything</button>
          </div>
          <div class="form">
            ${field('From', '<input type="datetime-local" name="startTime">', { opt: true })}
            ${field('To', '<input type="datetime-local" name="stopTime">', { opt: true })}
          </div>
          <div class="hint" style="margin-top:6px">Your browser's local time. Leave both blank for everything the charger holds. Many chargers ignore the range and send their whole log buffer.</div>
        </fieldset>
        <fieldset style="margin-top:14px"><legend>Upload target</legend>
          <label class="check"><input type="radio" name="target" value="builtin" checked><span><b>PlugSure built-in receiver (recommended)</b>
            <span class="cell-sub" style="display:block">A one-time, unguessable upload URL on this server. The file is stored with the request and opens in the log viewer here.</span></span></label>
          <label class="check" style="margin-top:10px"><input type="radio" name="target" value="custom"><span><b>Custom server</b>
            <span class="cell-sub" style="display:block">Your own FTP / FTPS / SFTP / HTTPS server. PlugSure tracks the status only; the file is not viewable here.</span></span></label>
          <div data-custom style="margin-top:10px;display:none">
            ${field('Upload URL', '<input name="location" class="mono" autocomplete="off" spellcheck="false" placeholder="ftps://user:password@logs.example.co.id/plugsure/">', {
              help: 'ftp://, ftps://, sftp:// or https://. The charger connects to this address directly, so it must be reachable from the charger\'s network. Credentials in the URL are sent to the charger in clear.',
            })}
          </div>
          <div data-basewarn style="margin-top:10px"></div>
        </fieldset>
      </form>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Send request', kind: 'primary', onClick: submit },
      ],
      onClose: () => resolve(ok),
    });
    const form = $('form', ctx.body);
    const setRange = (h) => {
      $$('[data-range] button', form).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.h) === h)));
      const now = new Date();
      $('[name=startTime]', form).value = h ? toLocalInput(new Date(now.getTime() - h * 3600_000)) : '';
      $('[name=stopTime]', form).value = h ? toLocalInput(now) : '';
    };
    const paintTarget = () => {
      $('[data-custom]', form).style.display = target === 'custom' ? '' : 'none';
      $('[data-basewarn]', form).innerHTML = target === 'builtin' && !publicBase()
        ? callout('warn', `<b>PUBLIC_BASE_URL is not set.</b> The charger will be told to upload to <span class="mono">${esc(location.origin)}</span>, the address your browser is using. If chargers cannot reach it (localhost, a VPN or internal hostname), the upload fails; set PUBLIC_BASE_URL or use a custom server.`)
        : '';
    };
    on(form, 'click', '[data-range] button', (e, b) => setRange(Number(b.dataset.h)));
    on(form, 'input', '[name=startTime], [name=stopTime]', () => $$('[data-range] button', form).forEach((b) => b.setAttribute('aria-pressed', 'false')));
    on(form, 'change', '[name=target]', (e, i) => { target = i.value; paintTarget(); });
    setRange(24);
    paintTarget();

    async function submit() {
      fieldErrors(form, {});
      const err = $('[data-err]', form);
      err.innerHTML = '';
      const errs = {};
      const sv = $('[name=startTime]', form).value;
      const ev = $('[name=stopTime]', form).value;
      const start = sv ? new Date(sv) : null;
      const stop = ev ? new Date(ev) : null;
      if (start && Number.isNaN(start.getTime())) errs.startTime = 'Not a valid date and time';
      if (stop && Number.isNaN(stop.getTime())) errs.stopTime = 'Not a valid date and time';
      if (start && stop && !errs.startTime && !errs.stopTime && stop <= start) errs.stopTime = 'Must be after the start';
      const loc = target === 'custom' ? $('[name=location]', form).value.trim() : '';
      if (target === 'custom' && !/^(ftp|ftps|sftp|https?):\/\/\S+$/i.test(loc)) errs.location = 'Enter an ftp://, ftps://, sftp:// or https:// URL';
      if (Object.keys(errs).length) { fieldErrors(form, errs); return false; }
      try {
        const r = await api(`/v1/charge-points/${enc(cp.ocpp_identity)}/diagnostics`, {
          method: 'POST',
          body: { startTime: start ? start.toISOString() : null, stopTime: stop ? stop.toISOString() : null, location: loc || null },
        });
        ok = true;
        toast(`${cp.ocpp_identity} accepted the request${r?.fileName ? ` and will upload ${r.fileName}` : ''}. Status updates appear below.`, 'ok');
      } catch (e) {
        err.innerHTML = `<div style="margin-bottom:12px">${callout('crit', `<b>The request was not sent.</b> ${esc(e.message)}`)}</div>`;
        return false;
      }
      return undefined;
    }
  });
}

const ERR_RE = /\b(ERROR|ERR|FATAL|FAULT|CRITICAL|EXCEPTION|E\d{3,4})\b/i;
const WARN_RE = /\b(WARN|WARNING)\b/i;

/** Escape FIRST, then wrap the (escaped) matches: the raw line never reaches innerHTML. */
function highlight(line, needle) {
  if (!needle) return { html: esc(line), n: 0 };
  const lower = line.toLowerCase();
  let out = '';
  let i = 0;
  let n = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    out += `${esc(line.slice(i, j))}<mark>${esc(line.slice(j, j + needle.length))}</mark>`;
    i = j + needle.length;
    n++;
  }
  return { html: out + esc(line.slice(i)), n };
}

/** Embedded log viewer (modal xl). */
async function openLogViewer(row) {
  const ctx = modal({
    title: `Diagnostic log — ${row.ocpp_identity ?? ''}`,
    subtitle: `${row.file_name ?? 'unnamed file'} · ${fmt.bytes(row.size_bytes)} · requested ${fmt.time(row.requested_at)}`,
    size: 'xl',
    body: '<div class="skeleton" style="width:40%"></div>',
    actions: [
      { label: 'Download file', onClick: () => { downloadDiag(row); return false; } },
      { label: 'Close' },
    ],
  });
  const body = ctx.body;
  let c;
  try {
    c = await api(`/v1/diagnostics/${enc(row.id)}/content`);
  } catch (e) {
    body.innerHTML = callout('crit', esc(e.message));
    return;
  }
  if (!body.isConnected) return;
  if (!c?.available) {
    body.innerHTML = callout('info', esc(c?.note ?? 'No file has been received for this request.'));
    return;
  }
  if (c.binary || c.text == null) {
    body.innerHTML = `${callout('info', `<b>${esc(c.fileName ?? row.file_name ?? 'This file')}</b> cannot be shown as text: ${esc(c.note ?? 'binary file')}.`)}
      <div class="row" style="margin-top:12px"><button type="button" class="btn primary" data-dl>${icon('download')} Download to inspect</button></div>`;
    $('[data-dl]', body).addEventListener('click', () => downloadDiag(row));
    return;
  }

  const lines = String(c.text).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const kinds = lines.map((l) => (ERR_RE.test(l) ? 'e' : WARN_RE.test(l) ? 'w' : ''));
  const errCount = kinds.filter((k) => k === 'e').length;
  const warnCount = kinds.filter((k) => k === 'w').length;
  const width = String(lines.length).length;

  body.innerHTML = `
    ${c.note ? `<div style="margin-bottom:8px">${callout('info', esc(c.note))}</div>` : ''}
    ${c.truncated ? `<div style="margin-bottom:8px">${callout('warn', 'Only the first 2 MB is shown. Download the file for the rest.')}</div>` : ''}
    <div class="row" style="margin-bottom:10px">
      <div class="inputgroup" style="flex:1;min-width:240px"><input type="search" data-q placeholder="Search the log (case-insensitive)" aria-label="Search the log">
        <button type="button" class="btn" data-prev title="Previous match" aria-label="Previous match">↑</button><button type="button" class="btn" data-next title="Next match" aria-label="Next match">↓</button></div>
      <label class="check"><input type="checkbox" data-errors> Errors only</label>
      <label class="check"><input type="checkbox" data-warns disabled> + warnings</label>
      <span class="small muted" data-stats></span>
    </div>
    <div class="logview" data-log tabindex="0" aria-label="Log contents"></div>
    <div class="hint" style="margin-top:6px">Red: ERROR, ERR, FATAL, FAULT, CRITICAL, EXCEPTION and E### codes (${esc(errCount)} lines). Amber: WARN / WARNING (${esc(warnCount)} lines). Shown as plain text exactly as the charger sent it.</div>`;

  const qEl = $('[data-q]', body);
  const errEl = $('[data-errors]', body);
  const warnEl = $('[data-warns]', body);
  const logEl = $('[data-log]', body);
  const statsEl = $('[data-stats]', body);
  let cur = -1;

  const paint = () => {
    const needle = qEl.value.trim().toLowerCase();
    const errOnly = errEl.checked;
    const withWarn = warnEl.checked;
    const parts = [];
    let shown = 0;
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      const k = kinds[i];
      if (errOnly && !(k === 'e' || (withWarn && k === 'w'))) continue;
      const h = highlight(lines[i], needle);
      hits += h.n;
      shown++;
      parts.push(`<span class="muted">${String(i + 1).padStart(width, ' ')}  </span>${k ? `<span class="${k}">${h.html}</span>` : h.html}`);
    }
    logEl.innerHTML = parts.length ? parts.join('\n') : '<span class="muted">No lines to show with these filters.</span>';
    statsEl.textContent = `${fmt.num(shown)} of ${fmt.num(lines.length)} lines${needle ? ` · ${fmt.num(hits)} ${hits === 1 ? 'match' : 'matches'}` : ''}`;
    cur = -1;
    if (needle && hits) jump(1);
  };
  const jump = (dir) => {
    const marks = $$('mark', logEl);
    if (!marks.length) return;
    if (marks[cur]) marks[cur].style.outline = '';
    cur = (cur + dir + marks.length) % marks.length;
    marks[cur].style.outline = '2px solid #f7c65c';
    marks[cur].scrollIntoView({ block: 'center' });
  };
  qEl.addEventListener('input', debounce(paint, 200));
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });
  errEl.addEventListener('change', () => { warnEl.disabled = !errEl.checked; paint(); });
  warnEl.addEventListener('change', paint);
  $('[data-prev]', body).addEventListener('click', () => jump(-1));
  $('[data-next]', body).addEventListener('click', () => jump(1));
  paint();
}

let lastDiagIdentity = '';

async function renderDiagnostics(pane, app, presetIdentity) {
  if (!state.can('charge_point:read')) {
    pane.innerHTML = callout('warn', 'Viewing diagnostic logs needs the charge point read permission. Ask an administrator for access.');
    return undefined;
  }
  const cps = (await api('/v1/charge-points').catch(() => []))
    .filter((c) => c.status !== 'decommissioned')
    .sort((a, b) => String(a.ocpp_identity).localeCompare(String(b.ocpp_identity)));
  if (!app.alive()) return undefined;
  const has = (id) => cps.some((c) => c.ocpp_identity === id);
  let identity = has(presetIdentity) ? presetIdentity : has(lastDiagIdentity) ? lastDiagIdentity : '';
  let rows = [];
  let timer = null;

  pane.innerHTML = `<div class="card pad">
      <div class="filters" style="margin-bottom:10px">
        ${field('Charge point', `<select data-cp style="min-width:320px">${options(
          cps.map((c) => ({ value: c.ocpp_identity, label: `${c.ocpp_identity}${c.display_name ? ` — ${c.display_name}` : ''} · ${c.site_name ?? '—'} · ${c.online ? 'online' : 'offline'}` })),
          identity,
          { blank: cps.length ? 'Choose a charger…' : 'No chargers yet' },
        )}</select>`)}
        <div class="row" style="padding-bottom:1px">
          ${canDiag() ? `<button type="button" class="btn primary" data-req disabled>${icon('download')} Request logs</button>` : ''}
          <button type="button" class="btn ghost" data-refresh disabled>${icon('refresh')} Refresh</button>
        </div>
      </div>
      ${callout('info', 'Pull a charger\'s internal logs without a site visit. PlugSure sends <span class="mono">GetDiagnostics</span>; the charger bundles its logs for the chosen period and uploads the file itself. Status moves <b>Requested → Uploading → Uploaded</b> as the charger reports progress. Files sent to the built-in receiver open in the log viewer with error codes highlighted.')}
    </div>
    <div data-cpinfo style="margin-top:12px"></div>
    <div class="card section" data-list></div>`;
  const listEl = $('[data-list]', pane);
  const sel = $('[data-cp]', pane);
  sel.value = identity;

  const cpNow = () => cps.find((c) => c.ocpp_identity === identity) ?? null;

  const draw = async () => {
    clearTimeout(timer);
    const cp = cpNow();
    const reqBtn = $('[data-req]', pane);
    if (reqBtn) {
      reqBtn.disabled = !cp || !cp.online;
      reqBtn.title = !cp ? 'Choose a charger first' : !cp.online ? 'The charger is offline' : '';
    }
    $('[data-refresh]', pane).disabled = !cp;
    $('[data-cpinfo]', pane).innerHTML = cp && !cp.online
      ? callout('warn', `<b>${esc(cp.ocpp_identity)} is offline</b> (last seen ${esc(fmt.ago(cp.last_seen_at))}). A log request needs a live connection; earlier requests are listed below.`)
      : '';
    if (!cp) {
      listEl.innerHTML = `<div class="empty-state"><h3>Choose a charger</h3><p>Its log requests and received files appear here.</p></div>`;
      return;
    }
    const want = identity;
    const list = await api(`/v1/charge-points/${enc(want)}/diagnostics`);
    if (!app.alive() || want !== identity) return;
    rows = list;
    table(listEl, {
      columns: [
        { label: 'Status', render: (r) => `${diagTag(r.status)}<div class="cell-sub wrap" style="max-width:260px">${esc(DIAG[r.status]?.[2] ?? '')}</div>` },
        { label: 'Requested', render: (r) => `<div class="nowrap">${esc(fmt.time(r.requested_at))}</div><div class="cell-sub">${esc(fmt.ago(r.requested_at))}</div>` },
        {
          label: 'Log window',
          render: (r) => (r.start_time || r.stop_time
            ? `<div class="small nowrap">${esc(fmt.time(r.start_time))}</div><div class="small nowrap">→ ${esc(fmt.time(r.stop_time))}</div>`
            : '<span class="muted small">everything held</span>'),
        },
        {
          label: 'Upload target',
          render: (r) => (r.builtin ? tag('t-info', 'built-in receiver') : `<span class="mono small wrap">${esc(maskLocation(r.location))}</span>`),
        },
        { label: 'File', render: (r) => (r.file_name ? `<span class="mono small wrap">${esc(r.file_name)}</span>` : '<span class="muted">—</span>') },
        { label: 'Size', num: true, render: (r) => esc(r.size_bytes != null ? fmt.bytes(r.size_bytes) : '—') },
        {
          label: '',
          render: (r, i) => (r.has_file
            ? `<div class="row nowrap" style="gap:4px;justify-content:flex-end"><button type="button" class="btn sm" data-act="view" data-i="${i}">${icon('search')} View</button>
                <button type="button" class="btn sm ghost icon" data-act="dl" data-i="${i}" title="Download" aria-label="Download">${icon('download')}</button></div>`
            : !r.builtin && r.status === 'Uploaded' ? '<span class="cell-sub">on your server</span>' : ''),
        },
      ],
      rows,
      empty: 'No log requests for this charger yet.',
    });
    if (rows.some((r) => r.status === 'Requested' || r.status === 'Uploading')) {
      timer = setTimeout(() => { if (app.alive()) draw().catch(() => {}); }, 5000);
    }
  };

  sel.addEventListener('change', () => {
    identity = sel.value;
    lastDiagIdentity = identity;
    draw().catch((e) => toast(e.message, 'crit'));
  });
  $('[data-refresh]', pane).addEventListener('click', () => draw().catch((e) => toast(e.message, 'crit')));
  $('[data-req]', pane)?.addEventListener('click', async () => {
    const cp = cpNow();
    if (!cp) return;
    if (await openDiagRequest(cp)) draw().catch(() => {});
  });
  on(listEl, 'click', '[data-act]', (e, b) => {
    const r = rows[Number(b.dataset.i)];
    if (!r) return;
    const row = { ...r, ocpp_identity: r.ocpp_identity ?? identity };
    if (b.dataset.act === 'view') openLogViewer(row);
    if (b.dataset.act === 'dl') downloadDiag(row);
  });

  await draw().catch((e) => { listEl.innerHTML = callout('crit', esc(e.message)); });
  const redraw = debounce(() => { if (app.alive()) draw().catch(() => {}); }, 400);
  const off = onLive((e) => {
    if (e.kind === 'diagnostics.status' && identity && (!e.payload?.ocppIdentity || e.payload.ocppIdentity === identity)) redraw();
  });
  return () => { off(); clearTimeout(timer); };
}

// ------------------------------------------------------------------ view

const TABS = [
  { id: 'campaigns', label: 'Campaigns', render: renderCampaigns },
  { id: 'images', label: 'Firmware repository', render: renderImages },
  { id: 'diagnostics', label: 'Diagnostic logs', render: renderDiagnostics },
];

registerView('firmware', {
  title: 'Firmware & Diagnostics',
  icon: 'firmware',
  group: 'maintain',
  order: 30,
  perm: 'firmware:read',
  async render(root, params = []) {
    const [tabParam, argParam] = params;
    let disposed = false;
    let seq = 0;
    let tabCleanup = null;
    let current = TABS.some((t) => t.id === tabParam) ? tabParam : 'campaigns';
    const imageAddedSubs = new Set();

    root.innerHTML = pageHead(
      'Firmware & Diagnostics',
      'Roll firmware out to chargers over the air (OCPP UpdateFirmware) and pull their logs remotely (GetDiagnostics). Every step is reported back by the charger and shown live.',
      canWrite()
        ? `<button type="button" class="btn" data-add>${icon('upload')} Add firmware</button><button type="button" class="btn primary" data-new>${icon('plus')} New campaign</button>`
        : '',
    ) + `<div class="tabs" role="tablist">${TABS.map((t) => `<button type="button" role="tab" data-tab="${esc(t.id)}" aria-selected="false">${esc(t.label)}</button>`).join('')}</div>
      <div data-pane></div>`;
    const pane = $('[data-pane]', root);

    const show = async (id, arg) => {
      const tab = TABS.find((t) => t.id === id) ?? TABS[0];
      current = tab.id;
      const my = ++seq;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab.id)));
      try { tabCleanup?.(); } catch { /* ignore */ }
      tabCleanup = null;
      pane.innerHTML = '<div class="skeleton" style="height:160px"></div>';
      const alive = () => !disposed && my === seq;
      const app = {
        alive,
        goto: (t, a) => show(t, a),
        onImageAdded(fn) { imageAddedSubs.add(fn); return () => imageAddedSubs.delete(fn); },
      };
      try {
        const cleanup = await tab.render(pane, app, arg);
        if (typeof cleanup === 'function') {
          if (alive()) tabCleanup = cleanup;
          else cleanup();
        }
      } catch (e) {
        if (alive()) pane.innerHTML = callout('crit', `<b>This tab failed to load.</b> ${esc(e.message)}`);
      }
    };

    on(root, 'click', '[data-tab]', (e, b) => { if (b.dataset.tab !== current) show(b.dataset.tab); });
    $('[data-add]', root)?.addEventListener('click', async () => {
      const id = await openImageModal();
      if (!id || disposed) return;
      if (current === 'images') imageAddedSubs.forEach((fn) => fn());
      else show('images');
    });
    $('[data-new]', root)?.addEventListener('click', async () => {
      const id = await openCampaignWizard();
      if (id && !disposed) show('campaigns', id);
    });

    await show(current, argParam);
    return () => {
      disposed = true;
      try { tabCleanup?.(); } catch { /* ignore */ }
      tabCleanup = null;
    };
  },
});
