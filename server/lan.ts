import os from 'node:os';

export interface LanAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  interface: string;
  url: string;
}

/**
 * Usable LAN endpoints for the current machine. Loopback and link-local addresses are
 * excluded because they are not reachable from another workstation.
 */
export function getLanAddresses(port: number): LanAddress[] {
  const interfaces = os.networkInterfaces();
  const addresses: LanAddress[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const family = entry.family === 'IPv4' ? 'IPv4' : entry.family === 'IPv6' ? 'IPv6' : null;
      if (!family) continue;
      if (family === 'IPv6') {
        // fe80::/10 link-local addresses need a scope id and are not routable on a LAN.
        if (entry.address.toLowerCase().startsWith('fe80')) continue;
      }
      const bare = entry.address.split('%')[0];
      const host = family === 'IPv6' ? `[${bare}]` : bare;
      addresses.push({ address: bare, family, interface: name, url: `http://${host}:${port}` });
    }
  }

  return addresses.sort((left, right) => left.address.localeCompare(right.address));
}
