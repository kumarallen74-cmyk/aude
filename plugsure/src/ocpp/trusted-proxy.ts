import { BlockList, isIP } from 'node:net';

/**
 * Is `address` one of the configured proxies (addresses or CIDRs)?
 *
 * Only a trusted proxy's forwarding headers mean anything: X-Forwarded-Proto
 * and the client-certificate fingerprint header are client-supplied text when
 * they arrive from anywhere else.
 */
export function makeProxyMatcher(entries: string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const raw of entries) {
    const [addr, bits] = raw.split('/');
    const family = isIP(addr ?? '');
    if (!family) throw new Error(`OCPP_TRUSTED_PROXIES: "${raw}" is not an address or CIDR`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr!, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
        throw new Error(`OCPP_TRUSTED_PROXIES: "${raw}" has an invalid prefix length`);
      }
      list.addSubnet(addr!, prefix, type);
    }
  }
  return (address) => {
    if (!address) return false;
    // An IPv4 peer on a dual-stack socket arrives as ::ffff:a.b.c.d.
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (v4) return list.check(v4, 'ipv4');
    const family = isIP(address);
    return family ? list.check(address, family === 6 ? 'ipv6' : 'ipv4') : false;
  };
}
