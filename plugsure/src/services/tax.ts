/**
 * Re-export shim: the tax engines live in services/tax/ (docs/MULTI-COUNTRY-DESIGN.md
 * §D3). Kept so v1.6 import paths keep working; new code imports './tax/index.js'.
 */
export * from './tax/index.js';
