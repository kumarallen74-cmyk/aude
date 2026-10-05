import { $, esc, api, icon, toast, modal, formValues, fieldErrors, field, callout, copy, fmt } from './core.js';

/**
 * Two-step verification (authenticator app, TOTP) for the signed-in operator:
 *   enrolDialog   set it up — QR code, the secret for typing in by hand, a code to confirm,
 *                 then the recovery codes, shown once. `forced`: an administrator's account
 *                 must have it and the console opens only afterwards (the server holds every
 *                 other route until then).
 *   mfaDialog     the user menu entry: the status, or the set-up when it is off.
 *
 * No inline script or handler anywhere (CSP): every listener is attached here, and the QR
 * code (a data: URL from the server) is set as a property, never through markup.
 */

const CODE_INPUT = '<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="123456">';

/** The ten recovery codes, once. Resolves when the user confirms they kept them. */
function showRecoveryCodes(codes) {
  return new Promise((resolve) => {
    const text = codes.join('\n');
    modal({
      title: 'Recovery codes',
      subtitle: 'Each one signs you in once if you lose your phone.',
      dismissable: false,
      body: `${callout('warn', '<b>Shown once.</b> Store them somewhere safe and separate from your phone — a password manager or a printed copy in a locked drawer. Anyone holding one and your password can sign in as you.')}
        <div class="field" style="margin-top:12px"><label>Recovery codes</label>
          <div class="row" style="align-items:flex-start"><div class="secret grow" data-codes style="white-space:pre;line-height:1.7"></div>
          <button class="btn" type="button" data-copy>${icon('copy')} Copy</button></div></div>`,
      actions: [{ label: 'I have stored them safely', kind: 'primary' }],
      onMount(ctx) {
        $('[data-codes]', ctx.body).textContent = text;
        $('[data-copy]', ctx.body).addEventListener('click', () => copy(text));
      },
      onClose: () => resolve(),
    });
  });
}

/**
 * Set up two-step verification. onDone runs once it is on (and the recovery codes were
 * acknowledged). forced: there is no "Cancel", only "Sign out" (onSignOut).
 */
export async function enrolDialog({ forced = false, onDone = null, onSignOut = null } = {}) {
  let enrolment;
  try {
    enrolment = await api('/v1/auth/mfa/enrol', { method: 'POST' });
  } catch (e) {
    toast(e.message, 'crit');
    if (forced) onSignOut?.();
    return;
  }
  let finished = false;
  modal({
    title: 'Set up two-step verification',
    subtitle: forced
      ? 'Required for administrator accounts. The console opens once it is set up.'
      : 'Sign-in will ask for a code from your phone as well as your password.',
    dismissable: !forced,
    body: `<form class="form one" novalidate>
      <ol class="small" style="margin:0 0 6px 18px;padding:0">
        <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).</li>
        <li>Add an account by scanning this QR code.</li>
        <li>Enter the six-digit code the app shows.</li>
      </ol>
      <div class="row" style="justify-content:center"><img data-qr alt="QR code for your authenticator app" width="200" height="200" style="background:#fff;border-radius:8px;padding:6px"></div>
      <details class="small"><summary>Cannot scan? Type this key into the app</summary>
        <div class="row" style="margin-top:6px"><div class="secret grow" data-secret></div>
        <button class="btn" type="button" data-copy>${icon('copy')} Copy</button></div>
        <p class="muted" style="margin:6px 0 0">Time-based, 6 digits, every 30 seconds.</p></details>
      ${field('Code from the app', CODE_INPUT)}
    </form>`,
    actions: [
      // A forced set-up's "Sign out" just closes: onClose below signs out.
      forced ? { label: 'Sign out' } : { label: 'Cancel' },
      {
        label: 'Turn on',
        kind: 'primary',
        async onClick(ctx) {
          const v = formValues($('form', ctx.body));
          if (!/^\d{6}$/.test(String(v.code ?? '').trim())) { fieldErrors(ctx.body, { code: 'Enter the six-digit code' }); return false; }
          try {
            const r = await api('/v1/auth/mfa/enrol/confirm', { method: 'POST', body: { code: String(v.code).trim() } });
            finished = true;
            ctx.close();
            toast('Two-step verification is on', 'ok');
            await showRecoveryCodes(r.recoveryCodes ?? []);
            onDone?.();
          } catch (e) {
            fieldErrors(ctx.body, { code: e.message });
          }
          return false;
        },
      },
    ],
    onMount(ctx) {
      $('[data-qr]', ctx.body).src = enrolment.qrDataUrl;
      $('[data-secret]', ctx.body).textContent = enrolment.secret.match(/.{1,4}/g).join(' ');
      $('[data-copy]', ctx.body).addEventListener('click', () => copy(enrolment.secret));
      $('form', ctx.body).addEventListener('submit', (e) => e.preventDefault());
    },
    // The header's close button: a forced set-up cannot be skipped, so closing signs out.
    onClose: () => { if (forced && !finished) onSignOut?.(); },
  });
}

/** User menu → Two-step verification. */
export async function mfaDialog() {
  let st;
  try {
    st = await api('/v1/auth/mfa');
  } catch (e) {
    toast(e.message, 'crit');
    return;
  }
  if (!st.enabled) {
    enrolDialog({});
    return;
  }
  modal({
    title: 'Two-step verification',
    body: `${callout('ok', `<b>On</b> since ${esc(fmt.time(st.enabledAt))}. Sign-in asks for a code from your authenticator app.`)}
      <p>Recovery codes left: <b>${esc(st.recoveryCodesLeft)}</b> of 10.${st.recoveryCodesLeft <= 3 ? ' Running low — ask an administrator to reset two-step verification and set it up again for a fresh set.' : ''}</p>
      <p class="small muted">Lost your phone? Sign in with a recovery code, or ask another administrator to reset two-step verification from <b>Users &amp; Roles</b>.${st.required ? ' It is required for your account and cannot be turned off.' : ''}</p>`,
    actions: [{ label: 'Close' }],
  });
}
