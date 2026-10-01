import { type Op, type Schema, ref, nullable, OK } from '../types.js';

const S: Schema = { type: 'string' };
const B: Schema = { type: 'boolean' };
const COLOR: Schema = { type: 'string', pattern: '^#[0-9a-f]{6}$' };
const theme: Schema = {
  type: 'object',
  required: ['accent', 'ink', 'soft', 'contrast'],
  properties: {
    accent: { type: 'string', description: 'The accent as used: nudged darker (light theme) or lighter (dark theme) until text in it reads at 4.5:1 or more on every surface and on its own tint.' },
    ink: { type: 'string', description: 'Text on a solid accent fill (buttons).' },
    soft: { type: 'string', description: 'The accent’s tint behind tags and highlights.' },
    contrast: { type: 'number', description: 'Lowest contrast of the accent against the theme’s surfaces and its tint.' },
  },
};

export const schemas: Record<string, Schema> = {
  ConsoleBrand: {
    type: 'object',
    description: 'The operator’s own console brand.',
    required: ['orgId', 'productName', 'tagline', 'brandColor', 'accentColor', 'hasLogo', 'logoSha256', 'hostname', 'showPoweredBy', 'updatedAt'],
    properties: {
      orgId: { type: 'string', format: 'uuid' },
      productName: { type: 'string', maxLength: 30, description: 'Replaces “PlugSure” in the console.', examples: ['NusaCharge Ops'] },
      tagline: nullable('string', { maxLength: 30, description: 'Under the name in the sidebar.' }),
      brandColor: { ...COLOR, description: 'The sign-in panel, avatars and the logo tile.' },
      accentColor: { ...COLOR, description: 'Buttons, links and highlights.' },
      hasLogo: B,
      logoSha256: nullable('string', { description: 'The logo’s hash; it is served at /console-brand/<hash>.png.' }),
      hostname: nullable('string', { description: 'The console’s own web address, e.g. console.nusantaracharge.id.' }),
      showPoweredBy: { type: 'boolean', description: 'Show “Powered by PlugSure” in the sidebar.' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ConsoleBrandView: {
    type: 'object',
    description: 'What the console paints with.',
    required: ['productName', 'tagline', 'logoUrl', 'palette', 'showPoweredBy'],
    properties: {
      productName: S,
      tagline: nullable('string'),
      logoUrl: nullable('string', { description: 'A 256 × 256 PNG, public and cacheable (content-addressed).' }),
      palette: {
        type: 'object', required: ['light', 'dark', 'brand', 'brandDeep', 'adjusted'],
        properties: {
          light: theme, dark: theme,
          brand: { type: 'string', description: 'The brand colour as used: darkened if needed so white text on it reads at 4.5:1 or more.' },
          brandDeep: S,
          adjusted: { type: 'boolean', description: 'A colour was changed to stay readable.' },
        },
      },
      showPoweredBy: B,
    },
  },
  ConsoleBrandResult: {
    type: 'object',
    required: ['brand', 'view'],
    properties: {
      brand: { anyOf: [ref('ConsoleBrand'), { type: 'null' }], description: 'Null: the console uses the PlugSure brand.' },
      view: { anyOf: [ref('ConsoleBrandView'), { type: 'null' }] },
    },
  },
};

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/console-brand', tag: 'Console branding',
    summary: 'The operator’s console brand',
    description: 'The name, tagline, colours, logo and web address the operator’s console uses instead of PlugSure’s, and the colours as the console applies them in both themes.',
    responses: { 200: { description: 'The brand (null when none)', schema: ref('ConsoleBrandResult') } },
  },
  {
    method: 'PUT', path: '/v1/console-brand', tag: 'Console branding',
    summary: 'Create or change the console brand',
    description:
      'Fields left out keep their value; the product name is required when creating. Everyone who signs in to the organisation sees the brand. ' +
      'With a web address, the sign-in page on it shows the brand and only this operator’s accounts may sign in there; the address must also be added to the web server (deploy/Caddyfile). ' +
      '409 when another operator’s console or any driver app uses the web address, or in a sandbox.',
    body: {
      schema: {
        type: 'object',
        properties: { productName: { type: 'string', maxLength: 30 }, tagline: { type: ['string', 'null'], maxLength: 30 }, brandColor: S, accentColor: S, hostname: { type: ['string', 'null'] }, showPoweredBy: B },
      },
      example: { productName: 'NusaCharge Ops', tagline: 'Network operations', brandColor: '#12305a', accentColor: '#ff8a00', hostname: 'console.nusantaracharge.id', showPoweredBy: false },
    },
    responses: { 200: { description: 'The brand as saved', schema: ref('ConsoleBrandResult') } },
    errors: [409, 422],
  },
  {
    method: 'PUT', path: '/v1/console-brand/logo', tag: 'Console branding',
    summary: 'Upload the console logo',
    description: 'A square PNG, 64 to 2048 pixels (256 or more is best), up to 1 MB, as base64. It is stored as 256 × 256. Needs the brand first (404).',
    body: { schema: { type: 'object', required: ['png'], properties: { png: { type: 'string', description: 'Base64 PNG (a data: URL is accepted).' } } } },
    responses: {
      200: {
        description: 'The brand, with what was stored',
        schema: {
          allOf: [ref('ConsoleBrandResult'), {
            type: 'object', required: ['logo'],
            properties: { logo: { type: 'object', required: ['width', 'height', 'bytes', 'sha256'], properties: { width: { type: 'integer' }, height: { type: 'integer' }, bytes: { type: 'integer' }, sha256: S } } },
          }],
        },
      },
    },
    errors: [404, 413, 422],
  },
  {
    method: 'DELETE', path: '/v1/console-brand/logo', tag: 'Console branding',
    summary: 'Remove the console logo',
    description: 'The console shows the product name’s initials on the brand colour instead.',
    responses: { 200: { description: 'The brand without its logo', schema: ref('ConsoleBrandResult') } },
    errors: [404],
  },
  {
    method: 'DELETE', path: '/v1/console-brand', tag: 'Console branding',
    summary: 'Remove the console brand',
    description: 'The console goes back to the PlugSure brand. Its web address, if any, then shows the PlugSure sign-in page and accepts any account again.',
    responses: { 200: { description: 'Removed', schema: OK } },
    errors: [404],
  },
];
