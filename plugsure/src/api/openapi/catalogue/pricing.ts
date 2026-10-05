import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

const uuidList = (d: string): Schema => ({ type: ['array', 'null'], items: { type: 'string', format: 'uuid' }, description: d });

export const schemas: Record<string, Schema> = {
  SubscriptionPlan: {
    type: 'object',
    required: ['id', 'name', 'monthly_fee_minor', 'energy_discount_bps', 'included_kwh', 'waive_session_fees', 'offered_in_app', 'active'],
    properties: {
      id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, description: nullable('string'),
      monthly_fee_minor: { type: 'integer', description: 'Before tax.' },
      energy_discount_bps: { type: 'integer', description: 'Discount on energy in basis points (1000 = 10%).' },
      member_rate: { type: ['number', 'null'], description: 'Member price per kWh, used where it is lower than the tariff.' },
      included_kwh: { type: 'number', description: 'kWh per month (or per 30-day pass) at no charge.' },
      waive_session_fees: { type: 'boolean' },
      current_type: { type: ['string', 'null'], enum: ['AC', 'DC', null] },
      site_ids: uuidList('Sites the plan applies at; null = all.'),
      offered_in_app: { type: 'boolean' }, active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
      members: { type: 'integer' },
    },
  },
  SubscriptionPlanInput: {
    type: 'object',
    properties: {
      name: { type: 'string' }, description: { type: 'string' }, currency: { type: 'string', enum: ['IDR', 'MYR', 'SGD'], description: 'Set when created (default IDR); fixed after.' }, monthlyFeeMinor: { type: 'integer', minimum: 0 },
      memberRate: { type: ['number', 'null'], minimum: 0 }, energyDiscountPercent: { type: 'number', minimum: 0, maximum: 100 },
      includedKwh: { type: 'number', minimum: 0 }, waiveSessionFees: { type: 'boolean' },
      currentType: { type: ['string', 'null'], enum: ['AC', 'DC', null] }, siteIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      offeredInApp: { type: 'boolean' }, active: { type: 'boolean' },
    },
  },
  Subscription: {
    type: 'object',
    required: ['id', 'plan_id', 'plan_name', 'subscriber_kind', 'billing', 'status'],
    properties: {
      id: { type: 'string', format: 'uuid' }, plan_id: { type: 'string', format: 'uuid' }, plan_name: { type: 'string' },
      subscriber_kind: { type: 'string', enum: ['fleet_account', 'card', 'app_driver'] },
      fleet_account_id: nullable('string', { format: 'uuid' }), fleet_account_name: nullable('string'),
      token_id: nullable('string', { format: 'uuid' }), card_uid: nullable('string'),
      app_driver_id: nullable('string', { format: 'uuid' }), driver_phone: nullable('string'),
      billing: { type: 'string', enum: ['invoice', 'qris', 'complimentary'] },
      status: { type: 'string', enum: ['pending_payment', 'active', 'cancelled', 'expired'] },
      started_at: { type: 'string', format: 'date-time' },
      current_period_start: nullable('string', { format: 'date-time' }), current_period_end: nullable('string', { format: 'date-time' }),
      cancelled_at: nullable('string', { format: 'date-time' }), notes: nullable('string'), created_at: { type: 'string', format: 'date-time' },
      auto_renew: { type: 'boolean', description: 'App pass: renews itself with the driver\'s saved card or linked e-wallet.' },
      renew_error: { type: ['string', 'null'], description: 'Why the last automatic renewal did not go through (declined, waiting for the driver, method removed).' },
      renew_next_at: nullable('string', { format: 'date-time' }),
    },
  },
  LoyaltyProgram: {
    type: 'object',
    required: ['enabled', 'earnPer1000Minor', 'pointValueMinor', 'maxRedeemBps', 'expiryMonths'],
    properties: {
      enabled: { type: 'boolean' },
      earnPer1000Minor: { type: 'integer', minimum: 0, maximum: 1000, description: 'Points earned per Rp 1,000 of a session\'s receipt total (rounded down).' },
      pointValueMinor: { type: 'integer', minimum: 1, description: 'What one point takes off a session, in rupiah.' },
      maxRedeemBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'The most of a session\'s energy and fees points may pay, in basis points (5000 = half).' },
      expiryMonths: { type: 'integer', minimum: 1, maximum: 60, description: 'Each earning expires this many months after it was earned; points are spent oldest first.' },
    },
  },
  LoyaltyStats: {
    type: 'object',
    required: ['program', 'outstandingPoints', 'liabilityMinor', 'members', 'thisMonth'],
    properties: {
      program: ref('LoyaltyProgram'),
      outstandingPoints: { type: 'integer' }, liabilityMinor: { type: 'integer', description: 'What the outstanding points are worth.' }, members: { type: 'integer', description: 'Drivers holding points.' },
      thisMonth: { type: 'object', properties: { earned: { type: 'integer' }, redeemed: { type: 'integer' }, discountMinor: { type: 'integer' }, expired: { type: 'integer' } } },
    },
  },
  Promotion: {
    type: 'object',
    required: ['id', 'name', 'kind', 'value', 'audience', 'days_mask', 'stacks_with_membership', 'active'],
    properties: {
      id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, description: nullable('string'),
      kind: { type: 'string', enum: ['energy_percent', 'energy_rate', 'amount_off', 'free_kwh', 'waive_fees'] },
      value: { type: 'number', description: '% / Rp per kWh / Rp / kWh, by kind.' },
      audience: { type: 'string', enum: ['everyone', 'new_drivers', 'fleet_accounts', 'plan_members', 'code'] },
      code: nullable('string'), fleet_account_ids: uuidList('For audience fleet_accounts.'), plan_ids: uuidList('For audience plan_members.'),
      site_ids: uuidList('null = every site.'), current_type: { type: ['string', 'null'], enum: ['AC', 'DC', null] },
      starts_at: { type: 'string', format: 'date-time' }, ends_at: nullable('string', { format: 'date-time' }),
      days_mask: { type: 'integer', description: 'Bit 0 = Monday … bit 6 = Sunday.' },
      time_from: { type: ['string', 'null'], description: 'HH:MM local time at the site.' }, time_to: { type: ['string', 'null'] },
      min_kwh: { type: 'number' }, max_redemptions: nullable('integer'), max_per_customer: nullable('integer'), budget_minor: nullable('integer'),
      stacks_with_membership: { type: 'boolean' }, active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
      redemptions: { type: 'integer' }, discount_minor: { type: 'integer', description: 'Discount given so far.' }, customers: { type: 'integer' },
    },
  },
  PromotionInput: {
    type: 'object',
    properties: {
      name: { type: 'string' }, description: { type: 'string' },
      kind: { type: 'string', enum: ['energy_percent', 'energy_rate', 'amount_off', 'free_kwh', 'waive_fees'] },
      value: { type: 'number', minimum: 0 },
      audience: { type: 'string', enum: ['everyone', 'new_drivers', 'fleet_accounts', 'plan_members', 'code'] },
      code: { type: ['string', 'null'], pattern: '^[A-Za-z0-9-]{3,30}$' },
      fleetAccountIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, planIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      siteIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, currentType: { type: ['string', 'null'], enum: ['AC', 'DC', null] },
      startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: ['string', 'null'], format: 'date-time' },
      daysMask: { type: 'integer', minimum: 1, maximum: 127 }, timeFrom: { type: ['string', 'null'] }, timeTo: { type: ['string', 'null'] },
      minKwh: { type: 'number', minimum: 0 }, maxRedemptions: { type: ['integer', 'null'], minimum: 1 }, maxPerCustomer: { type: ['integer', 'null'], minimum: 1 },
      budgetMinor: { type: ['integer', 'null'], minimum: 1 }, stacksWithMembership: { type: 'boolean' }, active: { type: 'boolean' },
      currency: { type: 'string', enum: ['IDR', 'MYR', 'SGD'], description: 'Set when created (default IDR); fixed after. Applies to sessions in it only.' },
    },
  },
};

const T = 'Tariffs' as const;
const HOW = 'Applied at rating, after the regulatory caps and before PBJT-TL and PPN, as discount lines on the receipt. Each session gets the customer\'s membership plus at most one promotion — whichever combination is cheapest for the customer — judged at the time the session started.';

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/subscription-plans', tag: T, summary: 'List membership plans',
    description: 'Monthly plans: member price per kWh, % off energy, included kWh, service fee waived. ' + HOW,
    responses: { 200: { description: 'Plans', schema: { type: 'object', required: ['plans'], properties: { plans: arrayOf(ref('SubscriptionPlan')) } } } },
  },
  {
    method: 'POST', path: '/v1/subscription-plans', tag: T, summary: 'Create a membership plan',
    description: 'With `offeredInApp`, drivers can buy it in the app as a 30-day pass (QRIS, e-wallet or card), renewed by hand or automatically with a saved card or linked e-wallet. A driver switching to another plan has the unused days of the current pass credited.',
    body: { required: true, schema: ref('SubscriptionPlanInput'), example: { name: 'Member Hemat', monthlyFeeMinor: 99000, energyDiscountPercent: 10, includedKwh: 20, waiveSessionFees: true, offeredInApp: true } },
    responses: { 201: { description: 'Created', schema: ref('SubscriptionPlan') } },
    errors: [409, 422],
  },
  {
    method: 'PUT', path: '/v1/subscription-plans/:id', tag: T, summary: 'Update a membership plan', pathParams: { id: 'Plan id.' },
    description: 'Changes apply to sessions rated from now on.',
    body: { required: true, schema: ref('SubscriptionPlanInput'), example: { memberRate: 2100 } },
    responses: { 200: { description: 'Updated', schema: ref('SubscriptionPlan') } },
    errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/subscriptions', tag: T, summary: 'List members',
    query: [
      { name: 'planId', schema: { type: 'string', format: 'uuid' } },
      { name: 'status', schema: { type: 'string', enum: ['pending_payment', 'active', 'cancelled', 'expired'] } },
    ],
    responses: { 200: { description: 'Memberships', schema: { type: 'object', required: ['subscriptions'], properties: { subscriptions: arrayOf(ref('Subscription')) } } } },
  },
  {
    method: 'POST', path: '/v1/subscriptions', tag: T, summary: 'Enrol a member',
    description: 'A fleet account (every card on it) or one card, billed on the monthly fleet invoice or complimentary. A card on no fleet account can only be complimentary. One live membership per subscriber. App drivers subscribe themselves in the app.',
    body: {
      required: true,
      schema: {
        type: 'object', required: ['planId', 'subscriberKind'],
        properties: {
          planId: { type: 'string', format: 'uuid' }, subscriberKind: { type: 'string', enum: ['fleet_account', 'card'] },
          fleetAccountId: { type: 'string', format: 'uuid' }, cardUid: { type: 'string' },
          billing: { type: 'string', enum: ['invoice', 'complimentary'], default: 'invoice' }, notes: { type: 'string' },
        },
      },
      example: { planId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', subscriberKind: 'fleet_account', fleetAccountId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', billing: 'invoice' },
    },
    responses: { 201: { description: 'Enrolled', schema: ref('Subscription') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/subscriptions/:id/cancel', tag: T, summary: 'Cancel a membership', pathParams: { id: 'Subscription id.' },
    description: 'Benefits stop now. A membership billed on the fleet invoice is billed for the days of that month it was in force (as it is for a membership started mid-month).',
    responses: { 200: { description: 'Cancelled', schema: ref('Subscription') } },
    errors: [404, 409],
  },
  {
    method: 'GET', path: '/v1/loyalty', tag: T, summary: 'Get the loyalty program',
    description: 'The loyalty settings, the points drivers hold and what they are worth (a liability), and this month\'s points earned, spent and expired. Drivers signed in to the app earn points on what each session costs them; those who choose to use them have points taken off their sessions automatically, before PBJT-TL and PPN, like a discount.',
    responses: { 200: { description: 'Program and figures', schema: ref('LoyaltyStats') } },
  },
  {
    method: 'PUT', path: '/v1/loyalty', tag: T, summary: 'Save the loyalty program',
    description: 'Switch loyalty on or off and set the earn rate, the value of a point, the most points may pay of a session and when points expire. Changes apply to sessions rated from now on; points already earned keep their expiry. Audited.',
    body: { required: true, schema: { ...ref('LoyaltyProgram'), required: undefined } as Schema, example: { enabled: true, earnPer1000Minor: 1, pointValueMinor: 10, maxRedeemBps: 5000, expiryMonths: 12 } },
    responses: { 200: { description: 'Saved', schema: ref('LoyaltyStats') } },
    errors: [422],
  },
  {
    method: 'GET', path: '/v1/loyalty/members', tag: T, summary: 'List drivers with the most points',
    query: [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } }],
    responses: { 200: { description: 'Drivers, phone numbers masked', schema: { type: 'object', required: ['members'], properties: { members: arrayOf({ type: 'object', properties: { appDriverId: { type: 'string', format: 'uuid' }, phone: { type: 'string' }, name: nullable('string'), balance: { type: 'integer' }, autoRedeem: { type: 'boolean' }, lastActivity: { type: 'string', format: 'date-time' } } }) } } } },
  },
  {
    method: 'POST', path: '/v1/loyalty/adjust', tag: T, summary: 'Adjust a driver\'s points',
    description: 'Goodwill points (positive) or a correction (negative, never below zero), with the reason, which the driver sees in their history. Audited.',
    body: { required: true, schema: { type: 'object', required: ['appDriverId', 'points', 'note'], properties: { appDriverId: { type: 'string', format: 'uuid' }, points: { type: 'integer' }, note: { type: 'string', minLength: 3, maxLength: 200 } } }, example: { appDriverId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', points: 500, note: 'Sorry for the charger outage on 12 Oct' } },
    responses: { 200: { description: 'The driver\'s new balance', schema: { type: 'object', required: ['balance'], properties: { balance: { type: 'integer' } } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/promotions', tag: T, summary: 'List promotions',
    description: 'With how often each was used, by how many customers, and the discount given. ' + HOW,
    responses: { 200: { description: 'Promotions', schema: { type: 'object', required: ['promotions'], properties: { promotions: arrayOf(ref('Promotion')) } } } },
  },
  {
    method: 'POST', path: '/v1/promotions', tag: T, summary: 'Create a promotion',
    description: 'An offer (% off energy, a promo price per kWh, rupiah off, free kWh or service fee waived) for everyone, new drivers, chosen fleet accounts, members of chosen plans, or whoever enters its code in the app — limited by dates, days of the week, a time window (happy hour), sites, AC/DC, a minimum kWh, total and per-customer uses, and a budget.',
    body: { required: true, schema: ref('PromotionInput'), example: { name: 'Happy hour malam', kind: 'energy_percent', value: 20, audience: 'everyone', timeFrom: '22:00', timeTo: '06:00', budgetMinor: 5000000 } },
    responses: { 201: { description: 'Created', schema: ref('Promotion') } },
    errors: [409, 422],
  },
  {
    method: 'GET', path: '/v1/promotions/:id', tag: T, summary: 'Get a promotion', pathParams: { id: 'Promotion id.' },
    responses: { 200: { description: 'The promotion and its use', schema: ref('Promotion') } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/promotions/:id', tag: T, summary: 'Update a promotion', pathParams: { id: 'Promotion id.' },
    description: 'Set `active: false` to stop it. Sessions already rated keep their discount.',
    body: { required: true, schema: ref('PromotionInput'), example: { active: false } },
    responses: { 200: { description: 'Updated', schema: ref('Promotion') } },
    errors: [404, 409, 422],
  },
];
