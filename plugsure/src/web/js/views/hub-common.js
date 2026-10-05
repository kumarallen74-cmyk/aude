import { esc, asHtml, modal, field, formValues, fieldErrors } from '../core.js';

/** Shared by the hub screens (hub.js, hub-clearing.js, the tenant's hub tab in roaming.js). */

/**
 * A confirm dialog that asks why (the reason goes into the audit entry). Resolves to the reason, '' when one
 * is optional and left empty, or null when cancelled. `requireText` makes the operator type a phrase first.
 */
export function reasonDialog(o) {
  return reasonForm(o).then((r) => (r ? r.reason : null));
}

/**
 * The same dialog with extra fields (`extra` markup with named inputs): resolves to { reason, values } or null.
 * `validate(values)` may return { field: message } to keep it open.
 */
export function reasonForm({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null, reasonRequired = true, extra = '', reasonLabel = 'Reason', validate = null, onMount = null }) {
  return new Promise((resolve) => {
    let out = null;
    modal({
      title,
      body: `<p style="margin:0 0 12px">${asHtml(message)}</p>${extra}
        <div class="form one">
          ${field(reasonLabel, '<textarea name="reason" rows="2" maxlength="500" style="font-family:var(--sans);font-size:13px;min-height:60px" placeholder="e.g. ticket number, contract clause, who asked"></textarea>', { help: 'Kept with this action in the audit log.', opt: !reasonRequired })}
          ${requireText ? field(`Type ${requireText} to confirm`, '<input name="confirm" autocomplete="off">') : ''}
        </div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: confirmLabel, kind: danger ? 'danger' : 'primary',
          onClick(ctx) {
            const v = formValues(ctx.body);
            const errs = {};
            if (reasonRequired && !String(v.reason ?? '').trim()) errs.reason = 'Give a reason for the audit log';
            if (requireText && String(v.confirm ?? '').trim() !== requireText) errs.confirm = `Type ${requireText} exactly`;
            Object.assign(errs, validate?.(v) ?? {});
            if (Object.keys(errs).length) { fieldErrors(ctx.body, errs); return false; }
            out = { reason: String(v.reason ?? '').trim(), values: v };
          },
        },
      ],
      onMount,
      onClose: () => resolve(out),
    });
  });
}

