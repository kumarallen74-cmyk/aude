/**
 * Role-based access control.
 *
 * Permissions are (action, resource) pairs; roles bundle them; assignments are
 * SCOPED to an organisation, a site, or a fleet. A site host holds `session:read`
 * scoped to their own sites and never sees another host's revenue.
 *
 * Enforcement belongs at the QUERY layer, not the controller. Every tenant-scoped
 * query goes through a repository that injects the scope predicate; Postgres RLS
 * is the second line of defence, not the first.
 */

export type Permission =
  | 'org:read' | 'org:write'
  | 'site:read' | 'site:write'
  | 'charge_point:read' | 'charge_point:write' | 'charge_point:command'
  /** Read/write OCPP configuration keys, pull diagnostics. Held by field technicians. */
  | 'charge_point:config'
  | 'firmware:read' | 'firmware:write'
  | 'session:read' | 'session:write'
  /** Bulk CSV export of sessions and invoices. */
  | 'session:export'
  | 'tariff:read' | 'tariff:write'
  | 'token:read' | 'token:write'
  | 'payment:read' | 'payment:write'
  | 'invoice:read' | 'invoice:write'
  | 'compliance:read' | 'compliance:write'
  | 'smartcharging:read' | 'smartcharging:write'
  | 'audit:read'
  | 'user:read' | 'user:write'
  | 'webhook:read' | 'webhook:write'
  /** Alert notification routing: channels (e-mail, WhatsApp), contacts, rules, delivery log. */
  | 'alert:read' | 'alert:write'
  /** Roaming (OCPI): partners, the published network, pushed tokens and roaming sessions. */
  | 'roaming:read' | 'roaming:write'
  /** Fleet customer portal: a fleet account's own invoices, credit notes, this month's charging and cards. Granted per fleet account only. */
  | 'fleet:portal'
  | 'platform:admin';

export type ScopeType = 'org' | 'site' | 'fleet';

export interface Assignment {
  permissions: Permission[];
  scopeType: ScopeType;
  scopeId: string | null; // null under scopeType 'org' means the whole organisation
}

export interface Principal {
  userId: string;
  orgId: string;
  assignments: Assignment[];
  /**
   * Site owners this principal acts for (Site Owner portal users). Their grants
   * are expanded to SITE assignments for every site of the owner at load time,
   * so every existing site filter applies unchanged; this list is only used to
   * pick the owner's own statement.
   */
  ownerIds?: string[];
  /**
   * Fleet accounts this principal is a customer user of (fleet portal). Their grant
   * holds only fleet:portal, which no operator route accepts, so they see nothing
   * but the portal, and only for these accounts.
   */
  fleetAccountIds?: string[];
}

export const SYSTEM_ROLES: Record<string, Permission[]> = {
  platform_admin: ['platform:admin'],

  org_owner: [
    'org:read', 'org:write', 'site:read', 'site:write',
    'charge_point:read', 'charge_point:write', 'charge_point:command', 'charge_point:config',
    'firmware:read', 'firmware:write',
    'session:read', 'session:write', 'session:export', 'tariff:read', 'tariff:write',
    'token:read', 'token:write', 'payment:read', 'payment:write',
    'invoice:read', 'invoice:write', 'compliance:read', 'compliance:write',
    'smartcharging:read', 'smartcharging:write', 'audit:read',
    'user:read', 'user:write', 'webhook:read', 'webhook:write', 'alert:read', 'alert:write',
    'roaming:read', 'roaming:write',
  ],

  // ---------------------------------------------------------------------------
  // The five console roles of SPEC-UI-CSMS-2026-FINAL §10.1. Each is the
  // permissions matrix row, translated column by column:
  //
  //                     Fleet   Remote   Hardware  Tariffs   DLM     Users
  //   Super Admin       Full    Full     Full      Full      Full    Full
  //   CPO Ops Manager   Full    Full     Full      Full      Full    Read
  //   Site Host         Site    None     None      Revenue   Read    None
  //   Field Technician  Full    Test     Config    None      Read    None
  //   Financial Auditor Read    None     None      Export    Read    None
  //
  // "Site" is enforced by the SCOPE of the assignment (scopeType 'site'), not by
  // a different permission; "Test" (technician remote start) is enforced by the
  // remote-start route, which only lets a principal without session:write start
  // a session with a technician or VIP/test token.
  // ---------------------------------------------------------------------------

  super_admin: [
    'org:read', 'org:write', 'site:read', 'site:write',
    'charge_point:read', 'charge_point:write', 'charge_point:command', 'charge_point:config',
    'firmware:read', 'firmware:write',
    'session:read', 'session:write', 'session:export', 'tariff:read', 'tariff:write',
    'token:read', 'token:write', 'payment:read', 'payment:write',
    'invoice:read', 'invoice:write', 'compliance:read', 'compliance:write',
    'smartcharging:read', 'smartcharging:write', 'audit:read',
    'user:read', 'user:write', 'webhook:read', 'webhook:write', 'alert:read', 'alert:write',
    'roaming:read', 'roaming:write',
  ],

  cpo_operations_manager: [
    'org:read', 'site:read', 'site:write',
    'charge_point:read', 'charge_point:write', 'charge_point:command', 'charge_point:config',
    'firmware:read', 'firmware:write',
    'session:read', 'session:write', 'session:export', 'tariff:read', 'tariff:write',
    'token:read', 'token:write', 'payment:read', 'payment:write',
    'invoice:read', 'invoice:write', 'compliance:read', 'compliance:write',
    'smartcharging:read', 'smartcharging:write', 'audit:read',
    'user:read', 'alert:read', 'alert:write', 'roaming:read', 'roaming:write',
  ],

  site_host_landlord: [
    'site:read', 'charge_point:read', 'session:read', 'payment:read', 'invoice:read',
    'tariff:read', 'smartcharging:read', 'compliance:read',
  ],

  field_technician: [
    'site:read', 'charge_point:read', 'charge_point:command', 'charge_point:config',
    'firmware:read', 'token:read', 'smartcharging:read', 'compliance:read', 'alert:read',
  ],

  financial_auditor: [
    'site:read', 'charge_point:read', 'session:read', 'session:export',
    'tariff:read', 'payment:read', 'invoice:read', 'smartcharging:read', 'audit:read',
    'compliance:read', 'roaming:read',
  ],

  org_operator: [
    'site:read', 'charge_point:read', 'charge_point:write', 'charge_point:command',
    'session:read', 'token:read', 'token:write',
    'smartcharging:read', 'smartcharging:write', 'compliance:read',
  ],

  finance: ['site:read', 'session:read', 'payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'tariff:read'],

  compliance: ['site:read', 'charge_point:read', 'compliance:read', 'compliance:write', 'session:read', 'audit:read'],

  technician: ['site:read', 'charge_point:read', 'charge_point:write', 'charge_point:command', 'compliance:read'],

  /** Scoped to their own sites only. Sees their revenue share, never anyone else's. */
  site_host: ['site:read', 'charge_point:read', 'session:read', 'payment:read'],

  /**
   * Owner portal: a business that owns sites PlugSure operates. Granted per
   * OWNER (scope 'owner'), expanded to that owner's sites. Read-only: its
   * chargers, sessions (with export for its accounting), availability and its
   * monthly statement. No commands, no settings, no other owner's data.
   */
  site_owner: ['site:read', 'charge_point:read', 'session:read', 'session:export', 'invoice:read'],

  fleet_manager: ['session:read', 'token:read', 'token:write', 'invoice:read', 'charge_point:read', 'site:read'],

  /** Fleet portal: a fleet customer's own staff. Granted per FLEET ACCOUNT (scope 'fleet'). */
  fleet_customer: ['fleet:portal'],

  support_readonly: ['site:read', 'charge_point:read', 'session:read', 'token:read'],

  api_client: ['site:read', 'charge_point:read', 'session:read', 'charge_point:command'],
};

/**
 * The roles the console offers when inviting a user, in display order. The
 * legacy roles above stay valid for existing grants and API keys.
 */
export const CONSOLE_ROLES: Array<{ name: string; label: string; siteScoped: boolean; ownerScoped?: boolean; fleetScoped?: boolean; description: string }> = [
  { name: 'super_admin', label: 'Super Administrator', siteScoped: false,
    description: 'Everything in this organisation, including user management.' },
  { name: 'cpo_operations_manager', label: 'CPO Operations Manager', siteScoped: false,
    description: 'Runs the network: fleet, remote commands, hardware, tariffs and load management. Can view users.' },
  { name: 'site_host_landlord', label: 'Site Host / Landlord', siteScoped: true,
    description: 'Sees only the sites they host: live status, revenue and power. No commands.' },
  { name: 'field_technician', label: 'Field Technician', siteScoped: false,
    description: 'Monitors the fleet, runs diagnostic commands and test sessions, edits charger configuration.' },
  { name: 'financial_auditor', label: 'Financial Auditor', siteScoped: false,
    description: 'Read-only fleet visibility with full session, invoice and audit export.' },
  { name: 'site_owner', label: 'Site Owner (portal)', siteScoped: false, ownerScoped: true,
    description: "A business that owns sites you operate: sees only its own chargers, sessions, availability and monthly statement with its share. Read-only; follows the owner's sites automatically." },
  { name: 'fleet_customer', label: 'Fleet customer (portal)', siteScoped: false, fleetScoped: true,
    description: "Staff of a company you bill for fleet cards: sees only that fleet account's invoices, credit notes, this month's charging and its cards, and can block a lost card." },
];

export interface AccessRequest {
  permission: Permission;
  /** The resource being touched, for scope checking. */
  siteId?: string;
  fleetId?: string;
  orgId?: string;
}

export function can(p: Principal, req: AccessRequest): boolean {
  /**
   * The owning organisation of the resource must match the principal's.
   *
   * `platform:admin` used to waive this for EVERY permission: a platform
   * operator's credential could read and change any tenant's sessions, tariffs,
   * users and chargers through the ordinary tenant routes, and a stolen one was
   * a key to every tenant at once. Cross-organisation authority now exists only
   * where it is asked for by name — the platform routes, which all check
   * `platform:admin` itself (platform billing and commission statements,
   * platform-scoped integrations, pending chargers) and reach other
   * organisations deliberately, outside the caller's own RLS scope. Inside its
   * OWN organisation a platform admin still holds everything (the loop below).
   *
   * Row-level security already enforced the same line for the API: a request's
   * transaction is pinned to the caller's organisation, so another tenant's
   * charger or site resolved to "not found" before this check ever saw it.
   */
  if (req.orgId && req.orgId !== p.orgId) {
    if (req.permission !== 'platform:admin' || !hasPlatformAdmin(p)) return false;
  }

  for (const a of p.assignments) {
    if (!a.permissions.includes(req.permission) && !a.permissions.includes('platform:admin')) continue;

    if (a.scopeType === 'org' && (a.scopeId === null || a.scopeId === p.orgId)) {
      /**
       * FAIL CLOSED on an unresolved resource.
       *
       * An org-wide grant covers a specific site only when we know that site
       * belongs to this organisation. Previously `can()` returned true for ANY
       * siteId as soon as the principal held an org-scoped role, so one tenant
       * could read — and write — another tenant's site power budget. If a route
       * supplies a resource identifier it must also supply the owning org it
       * resolved; omitting it is a bug, and the safe reading of a bug is "no".
       */
      if ((req.siteId || req.fleetId) && req.orgId === undefined) return false;
      return true;
    }
    if (a.scopeType === 'site' && req.siteId && a.scopeId === req.siteId) return true;
    if (a.scopeType === 'fleet' && req.fleetId && a.scopeId === req.fleetId) return true;
  }
  return false;
}

export function hasPlatformAdmin(p: Principal): boolean {
  return p.assignments.some((a) => a.permissions.includes('platform:admin'));
}

export const ALL_PERMISSIONS: Permission[] = [
  'org:read', 'org:write', 'site:read', 'site:write',
  'charge_point:read', 'charge_point:write', 'charge_point:command', 'charge_point:config',
  'firmware:read', 'firmware:write',
  'session:read', 'session:write', 'session:export', 'tariff:read', 'tariff:write',
  'token:read', 'token:write', 'payment:read', 'payment:write',
  'invoice:read', 'invoice:write', 'compliance:read', 'compliance:write',
  'smartcharging:read', 'smartcharging:write', 'audit:read',
  'user:read', 'user:write', 'webhook:read', 'webhook:write', 'alert:read', 'alert:write',
  'roaming:read', 'roaming:write',
  'fleet:portal',
  'platform:admin',
];

/** Every permission this principal actually holds, across all its assignments. */
export function heldPermissions(p: Principal): Set<Permission> {
  if (hasPlatformAdmin(p)) return new Set(ALL_PERMISSIONS);
  const held = new Set<Permission>();
  for (const a of p.assignments) for (const perm of a.permissions) held.add(perm);
  return held;
}

export class PrivilegeEscalationError extends Error {
  statusCode = 403;
  constructor(public readonly denied: string[]) {
    super(
      `Cannot grant permissions you do not hold: ${denied.join(', ')}. ` +
        `A credential may only delegate a subset of its own authority.`,
    );
    this.name = 'PrivilegeEscalationError';
  }
}

/**
 * No credential may mint a credential more powerful than itself.
 *
 * `POST /v1/api-keys` required only `org:write` and then copied the requested
 * permission list verbatim, so any `org_owner` — exactly the credential you hand
 * a hardware vendor for integration testing — could issue itself a
 * `platform:admin` key and read, bill and command every other tenant on the
 * platform. Delegation must be monotonically non-increasing.
 *
 * Returns the sanitised list, or throws if the caller asked for more than it has.
 */
export function assertGrantable(p: Principal, requested: unknown): Permission[] {
  if (!Array.isArray(requested)) return [];
  const valid = new Set<string>(ALL_PERMISSIONS);
  const unknown = requested.filter((r) => typeof r !== 'string' || !valid.has(r));
  if (unknown.length) throw new PrivilegeEscalationError(unknown.map(String));

  const held = heldPermissions(p);
  const perms = requested as Permission[];
  const denied = perms.filter((perm) => !held.has(perm));
  if (denied.length) throw new PrivilegeEscalationError(denied);
  return [...new Set(perms)];
}

/**
 * Site IDs this principal may see, or null for "all sites in the organisation".
 * Repositories call this and inject the predicate — the controller never decides.
 */
export function visibleSiteIds(p: Principal, permission: Permission): string[] | null {
  const orgWide = p.assignments.some(
    (a) =>
      (a.permissions.includes(permission) || a.permissions.includes('platform:admin')) &&
      a.scopeType === 'org',
  );
  if (orgWide) return null;
  return p.assignments
    .filter((a) => a.scopeType === 'site' && a.permissions.includes(permission) && a.scopeId)
    .map((a) => a.scopeId!);
}

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(permission: Permission) {
    super(`missing permission: ${permission}`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(p: Principal, req: AccessRequest): void {
  if (!can(p, req)) throw new ForbiddenError(req.permission);
}

/**
 * For LIST endpoints that filter their rows with visibleSiteIds(): the caller
 * needs the permission in SOME scope, not org-wide. assertCan() without a
 * siteId only admits org-scoped grants, which shut a site-scoped Site Host out
 * of every list — including the list of their own sites. Never use this on a
 * route that does not scope its query by visibleSiteIds().
 */
export function assertCanAny(p: Principal, permission: Permission): void {
  if (!heldPermissions(p).has(permission)) throw new ForbiddenError(permission);
}
