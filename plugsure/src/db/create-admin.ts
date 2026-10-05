import { pool, one } from './pool.js';
import { logger } from '../logger.js';
import { ensureSystemRoles, hashPassword, generateTemporaryPassword, passwordProblem, setUserRole, tempPasswordTtlHours } from '../services/users.js';

/**
 * Bootstrap the FIRST console administrator — the one step that cannot be done
 * from the console, because nobody can sign in yet. Every later user is invited
 * from Users & Roles.
 *
 *   npm run create-admin -- --email ops@example.co.id --name "Ops Lead" \
 *        --org-slug my-cpo [--org-name "PT My CPO"] [--password '...']
 *
 * Production image (no tsx):  node dist/db/create-admin.js --email … --org-slug …
 *
 * Creates the organisation when --org-name is given and the slug is new. Without
 * --password a one-time password is generated and printed; the user must change
 * it at first sign-in. Idempotent on email: re-running resets that user's
 * password and makes them Super Administrator.
 *
 * --platform-admin additionally makes the account a PLATFORM administrator: the
 * platform operator's (PlugSure's) own staff, who set each customer's commission
 * plan and finalise monthly statements (Govern → Platform billing). Create it in
 * the operator's own organisation, never in a customer's:
 *   npm run create-admin -- --email billing@plugsure.com --org-slug plugsure --org-name "PlugSure" --platform-admin
 *
 * --reset-2fa also removes the account's two-step verification (authenticator secret and
 * recovery codes) and ends its sessions: the break-glass path for the LAST administrator
 * who lost their phone and recovery codes, when no other administrator can reset it from
 * Users & Roles. Needs shell access to the server, like the rest of this command.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim() || 'Administrator';
  const slug = arg('org-slug')?.trim();
  const orgName = arg('org-name')?.trim();
  const given = arg('password');
  const platformAdmin = process.argv.includes('--platform-admin');
  const reset2fa = process.argv.includes('--reset-2fa');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email is required');
  if (!slug) throw new Error('--org-slug is required (the organisation this administrator belongs to)');
  if (given) {
    const p = passwordProblem(given);
    if (p) throw new Error(p);
  }

  await ensureSystemRoles();

  let org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [slug]);
  if (!org) {
    if (!orgName) throw new Error(`organisation "${slug}" does not exist — pass --org-name to create it`);
    org = await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [orgName, slug]);
    logger.info({ slug }, 'organisation created');
  }

  const existing = await one<{ id: string; org_id: string }>(`SELECT id, org_id FROM app_user WHERE lower(email) = $1`, [email]);
  if (existing && existing.org_id !== org!.id) {
    throw new Error(`${email} already belongs to a different organisation — refusing to move it`);
  }

  const password = given ?? generateTemporaryPassword();
  const hash = await hashPassword(password);
  // Match an existing account case-insensitively, and always store the address in lower
  // case: sign-in matches on lower(email), and since migration 053 so does uniqueness
  // (app_user_email_lower_key) — the original UNIQUE(email) alone let "Ops@X" and "ops@x"
  // coexist. A generated one-time password expires after TEMP_PASSWORD_TTL_HOURS like any
  // other; a given --password is the account's real password and never expires.
  const tempExpiresHours = given ? null : tempPasswordTtlHours();
  const user = existing
    ? await one<{ id: string }>(
        `UPDATE app_user SET password_hash = $2, must_change_password = $3, status = 'active',
                failed_logins = 0, locked_until = NULL,
                temp_password_expires_at = CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() + ($4::numeric * interval '1 hour') END
          WHERE id = $1 RETURNING id`,
        [existing.id, hash, !given, tempExpiresHours],
      )
    : await one<{ id: string }>(
        `INSERT INTO app_user (org_id, email, name, status, password_hash, must_change_password, temp_password_expires_at)
         VALUES ($1, lower($2), $3, 'active', $4, $5,
                 CASE WHEN $6::numeric IS NULL THEN NULL ELSE now() + ($6::numeric * interval '1 hour') END) RETURNING id`,
        [org!.id, email, name, hash, !given, tempExpiresHours],
      );
  if (reset2fa) {
    await one(
      `UPDATE app_user SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
              totp_last_step = NULL, totp_recovery_hashes = '{}' WHERE id = $1 RETURNING id`,
      [user!.id],
    );
    await one(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [user!.id]);
    logger.warn({ email }, 'two-step verification removed (--reset-2fa); the administrator enrols again at next sign-in');
  }
  await setUserRole(user!.id, org!.id, 'super_admin');
  if (platformAdmin) {
    // The platform operator's own staff: sets customers' commission plans and
    // finalises their monthly statements. Never grant this to a customer.
    const r = await one<{ id: string }>(`SELECT id FROM role WHERE org_id IS NULL AND name = 'platform_admin'`);
    await one(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'org', $3) ON CONFLICT DO NOTHING RETURNING id`,
      [user!.id, r!.id, org!.id],
    );
  }

  logger.info('─────────────────────────────────────────────────────────────');
  logger.info(`${platformAdmin ? 'Platform Administrator (PlugSure operator)' : 'Super Administrator'}: ${email}`);
  if (!given) logger.info(`One-time password (shown once, change at first sign-in):  ${password}`);
  logger.info('Sign in at the console root URL.');
  logger.info('─────────────────────────────────────────────────────────────');
  await pool.end();
}

main().catch(async (e) => {
  logger.error(e.message ?? e);
  await pool.end().catch(() => {});
  process.exit(1);
});
