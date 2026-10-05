import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { brand } from '@/config';

/**
 * Hosted payment pages (card hold / Stripe, FPX, GrabPay, e-wallet checkout) in an auth session
 * (ASWebAuthenticationSession / Chrome Custom Tabs). Every payment request carries `returnUrl: <scheme>://paid`; the
 * server honours it only for the brand's own scheme (= its slug, spec §15.12) and gives the acquirer an https bounce
 * that redirects here, so the auth session closes on `<scheme>://paid?…` and the pay screen polls the server.
 */
export function returnUrl(): string {
  return `${brand.scheme}://paid`;
}

export type BrowserOutcome = { type: 'returned'; url: string } | { type: 'dismissed' } | { type: 'opened_external' };

export async function openCheckout(url: string): Promise<BrowserOutcome> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return { type: 'opened_external' };
  }
  const r = await WebBrowser.openAuthSessionAsync(url, returnUrl(), { preferEphemeralSession: false, showInRecents: true });
  if (r.type === 'success') return { type: 'returned', url: r.url };
  return { type: 'dismissed' };
}

export async function openLink(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}
