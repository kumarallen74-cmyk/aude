/**
 * What can be integrated, with which providers, and the fields each provider
 * needs. The console renders its forms from this; the store validates against
 * it. Fields of type 'secret' are sealed at rest and never returned.
 */

export type Kind = 'payments' | 'otp' | 'otp_fallback' | 'pnc_pki' | 'map_tiles';

export interface Field {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'select' | 'multiselect' | 'textarea' | 'url' | 'number' | 'boolean';
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean | string[];
  help?: string;
  placeholder?: string;
  /** Advanced: shown folded. */
  advanced?: boolean;
}

export interface ProviderDef {
  id: string;
  label: string;
  description: string;
  fields: Field[];
  /** Refused when NODE_ENV=production (test doubles). */
  devOnly?: boolean;
  /** The provider calls PlugSure back (payment notifications): show the webhook URL. */
  webhook?: boolean;
  docs?: string;
}

export interface KindDef {
  kind: Kind;
  label: string;
  description: string;
  /** org: each operator may have its own (falls back to the platform's); platform: one for the deployment. */
  scope: 'org' | 'platform';
  providers: ProviderDef[];
}

const envField = (def = 'sandbox'): Field => ({
  key: 'environment', label: 'Environment', type: 'select', default: def, required: true,
  options: [{ value: 'sandbox', label: 'Sandbox (test money)' }, { value: 'production', label: 'Production (real money)' }],
});
const baseUrl: Field = { key: 'baseUrl', label: 'API base URL', type: 'url', advanced: true, help: 'Only to point at a different endpoint (a proxy, or a test double). Leave empty for the provider\'s own.' };
/** Card holds and saved cards (acquirers that support them), off until the operator turns them on. */
const cardFields = (extra: Field[] = []): Field[] => [
  { key: 'cardHolds', label: 'Card payments: hold, then charge only what is used', type: 'boolean', default: false,
    help: 'The driver\'s card is authorised for the amount they choose; when the session ends only the actual total is captured and the rest is released at once. No refund queue for card payments. Card pre-authorisation must be enabled on your acquirer account.' },
  { key: 'saveCards', label: 'Let signed-in drivers save a card', type: 'boolean', default: false,
    help: 'The acquirer keeps the card and gives PlugSure a token (never the card number); next time the driver pays in one tap. Saved cards work only with this acquirer account.' },
  ...extra,
];
/** Post-pay for linked e-wallets: charge what the session cost after it ends. */
const postpayFields: Field[] = [
  { key: 'walletPostpay', label: 'Linked e-wallets: charge after the session (post-pay)', type: 'boolean', default: false,
    help: 'Nothing is charged at the start; the amount the driver chooses is a spending limit, and the session\'s actual total is charged from the linked e-wallet when it ends. A charge that fails is retried and listed under Refunds → Holds and post-pay; a driver with an unpaid session cannot start another post-pay session.' },
  { key: 'postpayLimitIdr', label: 'Post-pay limit per session (Rp)', type: 'number', default: 200000, advanced: true,
    help: 'The most a driver may charge on post-pay in one session. Higher amounts are paid up front.' },
  { key: 'postpayNeedsBalance', label: 'Post-pay only when the e-wallet balance can be checked', type: 'boolean', default: false, advanced: true,
    help: 'Before a post-pay session PlugSure checks the linked e-wallet\'s balance where the acquirer reports it (GoPay at Midtrans; OVO, DANA, ShopeePay and LinkAja at Xendit, when reported). On: when the balance cannot be read, that e-wallet is charged up front instead. Off: post-pay starts without the check.' },
];
/** Linked e-wallets (one-tap payments), off until the operator turns them on. */
const walletField = (which: string): Field => ({
  key: 'linkWallets', label: `Let signed-in drivers link ${which} for one-tap payments`, type: 'boolean', default: false,
  help: 'The driver links the e-wallet once, approving in its app; later payments go through in one tap. The chosen amount is charged and unused balance is refunded automatically. E-wallet tokenisation must be enabled on your acquirer account, and the e-wallet must be ticked above.',
});
/** The payment methods drivers may choose, among those the acquirer offers. QRIS stays on unless the operator unticks it. */
const METHOD_LABEL: Record<string, string> = { QRIS: 'QRIS (any bank or e-wallet app)', GOPAY: 'GoPay', SHOPEEPAY: 'ShopeePay', OVO: 'OVO', DANA: 'DANA', LINKAJA: 'LinkAja', CARD: 'Credit / debit card (3-D Secure, hosted page)' };
const methodsField = (offered: string[], def: string[] = ['QRIS']): Field => ({
  key: 'methods', label: 'Payment methods offered to drivers', type: 'multiselect', required: true, default: def,
  options: offered.map((v) => ({ value: v, label: METHOD_LABEL[v]! })),
  help: 'E-wallet and card payments are pre-purchases like QRIS: a fixed amount, confirmed by the acquirer\'s notification. Enable only the methods activated on your acquirer account.',
});

export const CATALOGUE: KindDef[] = [
  {
    kind: 'payments',
    label: 'Payments (QRIS, e-wallets, cards)',
    description: 'The acquirer (PJP) that takes drivers\' payments for walk-up charging, app passes and console checkout: dynamic QRIS and, where the acquirer offers them, e-wallets (GoPay, OVO, DANA, ShopeePay, LinkAja) and cards on its hosted 3-D Secure page. It confirms payments by webhook and, where it can, refunds unused balance.',
    scope: 'org',
    providers: [
      {
        id: 'midtrans', label: 'Midtrans', webhook: true, docs: 'https://docs.midtrans.com/reference/qris',
        description: 'Core API: QRIS, GoPay and ShopeePay (the driver is sent to the e-wallet app); cards on Midtrans Snap\'s hosted 3-D Secure page. Payments are confirmed by Midtrans\' HTTP notification (SHA-512 signature). Refunds by API.',
        fields: [
          envField(),
          { key: 'merchantId', label: 'Merchant ID', type: 'text', help: 'For reference only; the server key identifies the account.' },
          { key: 'serverKey', label: 'Server key', type: 'secret', required: true, placeholder: 'SB-Mid-server-…' },
          { key: 'acquirer', label: 'QRIS acquirer', type: 'select', default: 'gopay', options: [{ value: 'gopay', label: 'GoPay' }, { value: 'airpay shopee', label: 'ShopeePay' }] },
          methodsField(['QRIS', 'GOPAY', 'SHOPEEPAY', 'CARD']),
          walletField('GoPay'), ...postpayFields,
          ...cardFields([{ key: 'savedCard3ds', label: 'Saved cards: ask for 3-D Secure every time', type: 'boolean', default: true, help: 'Off: a saved card pays in one tap without 3-D Secure (Midtrans One Click, which Midtrans must enable on the account; you then carry the fraud liability).' }]),
          baseUrl,
        ],
      },
      {
        id: 'xendit', label: 'Xendit', webhook: true, docs: 'https://developers.xendit.co/api-reference/#qr-codes',
        description: 'QR Codes API (dynamic), GoPay (Payments API v3; linking needs Xendit to activate GoPay recurring on your account), e-wallet charges (OVO is pushed to the driver\'s OVO app; DANA, ShopeePay and LinkAja open the app) and cards on Xendit\'s hosted invoice page (3-D Secure). Payments are confirmed by Xendit\'s callbacks, checked with your callback verification token. E-wallet refunds by API; QRIS and card refunds by bank transfer from the Refunds page.',
        fields: [
          envField(),
          { key: 'secretKey', label: 'Secret API key', type: 'secret', required: true, placeholder: 'xnd_development_…' },
          { key: 'callbackToken', label: 'Callback verification token', type: 'secret', required: true, help: 'Xendit dashboard → Settings → Webhooks.' },
          { key: 'forUserId', label: 'Sub-account (for-user-id)', type: 'text', help: 'xenPlatform only: the operator\'s sub-account.' },
          methodsField(['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'CARD']),
          walletField('GoPay, OVO, DANA, ShopeePay and LinkAja'), ...postpayFields,
          ...cardFields(),
          baseUrl,
        ],
      },
      {
        id: 'snap', label: 'Bank direct (BI-SNAP)', webhook: true, docs: 'https://apidevportal.aspi-indonesia.or.id/',
        description: 'QRIS MPM directly with a bank under Bank Indonesia\'s SNAP standard (BRI, BCA, Mandiri, BNI…). Paths and a few fields differ per bank: confirm them in the bank\'s sandbox.',
        fields: [
          { key: 'baseUrl', label: 'Bank SNAP base URL', type: 'url', required: true, placeholder: 'https://sandbox.partner.api.bri.co.id' },
          { key: 'partnerId', label: 'Partner ID (X-PARTNER-ID)', type: 'text', required: true },
          { key: 'clientId', label: 'Client key (X-CLIENT-KEY)', type: 'text', required: true },
          { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
          { key: 'privateKeyPem', label: 'Your RSA private key (PEM)', type: 'secret', required: true, help: 'Signs the access-token request. Give the bank its public key.' },
          { key: 'bankPublicKeyPem', label: 'Bank public key (PEM)', type: 'textarea', required: true, help: 'Verifies the bank\'s payment notifications.' },
          { key: 'merchantId', label: 'Merchant ID', type: 'text', required: true },
          { key: 'terminalId', label: 'Terminal ID', type: 'text' },
          { key: 'channelId', label: 'Channel ID', type: 'text' },
          { key: 'accessTokenPath', label: 'Access-token path', type: 'text', default: '/v1.0/access-token/b2b', advanced: true },
          { key: 'generateQrPath', label: 'Generate-QR path', type: 'text', default: '/v1.0/qr/qr-mpm-generate', advanced: true },
        ],
      },
      {
        id: 'mock', label: 'Sandbox (no real money)', devOnly: true,
        description: 'Built-in test acquirer: QR codes that pay nothing, and a test checkout page for the e-wallets and cards; payments are confirmed with the demo button. Not available in production.',
        fields: [methodsField(['QRIS', 'GOPAY', 'SHOPEEPAY', 'OVO', 'DANA', 'LINKAJA', 'CARD'], ['QRIS', 'GOPAY', 'SHOPEEPAY', 'OVO', 'DANA', 'LINKAJA', 'CARD']), walletField('GoPay, OVO, DANA, ShopeePay and LinkAja'), ...postpayFields, ...cardFields()],
      },
    ],
  },
  {
    kind: 'otp',
    label: 'Driver sign-in codes',
    description: 'Sends the one-time code a driver types to sign in to the app with their phone number.',
    scope: 'platform',
    providers: [
      {
        id: 'whatsapp_cloud', label: 'WhatsApp (Meta Cloud API)', docs: 'https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates',
        description: 'An approved Authentication template with a copy-code button. Cheapest per message in Indonesia; most drivers have WhatsApp.',
        fields: [
          { key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true },
          { key: 'accessToken', label: 'Access token (System User)', type: 'secret', required: true },
          { key: 'templateName', label: 'Template name', type: 'text', required: true, default: 'plugsure_otp' },
          { key: 'language', label: 'Template language', type: 'text', required: true, default: 'id' },
          { key: 'copyCodeButton', label: 'Template has a copy-code button', type: 'boolean', default: true },
          { key: 'apiVersion', label: 'Graph API version', type: 'text', default: 'v20.0', advanced: true },
          { ...baseUrl, help: 'Default https://graph.facebook.com' },
        ],
      },
      {
        id: 'twilio', label: 'SMS — Twilio', docs: 'https://www.twilio.com/docs/sms/api/message-resource',
        description: 'Programmable Messaging. Use an alphanumeric sender registered for Indonesia, or a Messaging Service.',
        fields: [
          { key: 'accountSid', label: 'Account SID', type: 'text', required: true, placeholder: 'AC…' },
          { key: 'authToken', label: 'Auth token', type: 'secret', required: true },
          { key: 'from', label: 'Sender (From)', type: 'text', help: 'A number or registered sender ID. Or set a Messaging Service SID.' },
          { key: 'messagingServiceSid', label: 'Messaging Service SID', type: 'text', placeholder: 'MG…' },
          baseUrl,
        ],
      },
      {
        id: 'zenziva', label: 'SMS — Zenziva', docs: 'https://www.zenziva.id/dokumentasi/',
        description: 'Indonesian SMS gateway (regular SMS API).',
        fields: [
          { key: 'userkey', label: 'User key', type: 'text', required: true },
          { key: 'passkey', label: 'API key (passkey)', type: 'secret', required: true },
          { key: 'endpoint', label: 'Send endpoint', type: 'url', default: 'https://console.zenziva.net/reguler/api/sendsms/', advanced: true },
        ],
      },
      {
        id: 'http', label: 'Your SMS / WhatsApp gateway (HTTP)',
        description: 'Any provider behind a small endpoint of your own: PlugSure POSTs {to, code, message, channel} as JSON with a bearer token and expects HTTP 2xx.',
        fields: [
          { key: 'url', label: 'Endpoint URL', type: 'url', required: true },
          { key: 'token', label: 'Bearer token', type: 'secret', required: true },
          { key: 'channel', label: 'Channel', type: 'select', default: 'sms', options: [{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }] },
        ],
      },
      {
        id: 'dev', label: 'Development (code shown on screen)', devOnly: true,
        description: 'Nothing is sent; the code is shown in the app. Not available in production.',
        fields: [],
      },
    ],
  },
  {
    kind: 'otp_fallback',
    label: 'Sign-in codes — fallback',
    description: 'Used when the main channel fails (for example, the number has no WhatsApp).',
    scope: 'platform',
    providers: [],
  },
  {
    kind: 'pnc_pki',
    label: 'Plug & Charge PKI',
    description: 'The V2G PKI (Hubject or similar) behind ISO 15118: signs chargers\' V2G certificates, installs contract certificates in cars, supplies root certificates.',
    scope: 'platform',
    providers: [
      {
        id: 'http', label: 'PKI gateway (HTTP)',
        description: 'A gateway in front of your PKI provider\'s API, with the three calls described in deploy/README.md (sign, ev-certificates, roots).',
        fields: [
          { key: 'url', label: 'Gateway URL', type: 'url', required: true },
          { key: 'token', label: 'Bearer token', type: 'secret', required: true },
          { key: 'signer', label: 'Chargers\' V2G certificates signed by', type: 'select', default: 'pki', options: [{ value: 'pki', label: 'The PKI' }, { value: 'vault', label: 'My sub-CA in Vault' }] },
          { key: 'vaultMount', label: 'Vault PKI mount', type: 'text', default: 'pki_v2g', advanced: true },
          { key: 'vaultRole', label: 'Vault role', type: 'text', default: 'secc', advanced: true },
        ],
      },
      {
        id: 'mock', label: 'Test PKI', devOnly: true,
        description: 'Built-in test PKI for development and sandboxes. Not available in production.',
        fields: [],
      },
      {
        id: 'none', label: 'None',
        description: 'Plug & Charge certificate requests are answered Failed.',
        fields: [],
      },
    ],
  },
  {
    kind: 'map_tiles',
    label: 'Map tiles',
    description: 'The map in the driver app. The OpenStreetMap Foundation\'s server is for light use only: use your own or a commercial tile service for real traffic.',
    scope: 'platform',
    providers: [
      {
        id: 'custom', label: 'Tile service (XYZ)',
        description: 'Any https XYZ tile URL, e.g. MapTiler, Stadia, Thunderforest, or your own.',
        fields: [
          { key: 'tileUrl', label: 'Tile URL', type: 'url', required: true, placeholder: 'https://tiles.example.com/{z}/{x}/{y}.png?key=…', help: 'Must be https and contain {z}, {x} and {y}. An API key in the URL is visible to drivers\' browsers, as with every tile service.' },
          { key: 'attribution', label: 'Attribution', type: 'text', required: true, default: '© OpenStreetMap contributors' },
          { key: 'maxZoom', label: 'Maximum zoom', type: 'number', default: 19 },
        ],
      },
      {
        id: 'osm', label: 'OpenStreetMap (light use only)',
        description: 'tile.openstreetmap.org — fine for testing and very small fleets; its usage policy forbids heavy use.',
        fields: [],
      },
    ],
  },
];

// The fallback channel offers the same providers as the main one, minus the development one.
CATALOGUE.find((k) => k.kind === 'otp_fallback')!.providers = CATALOGUE.find((k) => k.kind === 'otp')!.providers.filter((p) => p.id !== 'dev');

export const kindDef = (k: string): KindDef | undefined => CATALOGUE.find((d) => d.kind === k);
export const providerDef = (k: string, p: string): ProviderDef | undefined => kindDef(k)?.providers.find((x) => x.id === p);
