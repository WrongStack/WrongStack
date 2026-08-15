import { describe, it, expect } from 'vitest';
import type * as os from 'node:os';
import { getExternalAddresses, formatExternalAccessUrls } from '../src/server/network-info.js';

function makeIf(
  addrs: Array<{ address: string; family: 'IPv4' | 'IPv6'; internal?: boolean }>,
): os.NetworkInterfaceInfo[] {
  return addrs.map((a) => ({
    address: a.address,
    netmask: '255.255.255.0',
    family: a.family,
    cidr: `${a.address}/24`,
    internal: a.internal ?? false,
    mac: '00:00:00:00:00:00',
    ...(a.family === 'IPv6' ? { scopeid: 0 } : {}),
  })) as os.NetworkInterfaceInfo[];
}

const FIXTURE: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  lo: makeIf([
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ]),
  eth0: makeIf([
    { address: '192.168.1.50', family: 'IPv4' },
    { address: 'fe80::1234', family: 'IPv6' }, // link-local → filtered
  ]),
  tailscale0: makeIf([
    { address: '100.64.0.42', family: 'IPv4' },
    { address: 'fd7a:115c:a1e0:ab12:4843:cd96:6246:9c2a', family: 'IPv6' },
    { address: 'fe80::5678', family: 'IPv6' }, // link-local → filtered
  ]),
  wlan0: makeIf([
    { address: '169.254.1.1', family: 'IPv4' }, // APIPA → filtered
    { address: '10.0.0.5', family: 'IPv4' },
  ]),
};

function getInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return FIXTURE;
}

describe('network-info', () => {
  describe('getExternalAddresses', () => {
    it('filters internal, link-local, and APIPA addresses', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const ips = addrs.map((a) => a.address);
      expect(ips).not.toContain('127.0.0.1');
      expect(ips).not.toContain('::1');
      expect(ips).not.toContain('fe80::1234');
      expect(ips).not.toContain('fe80::5678');
      expect(ips).not.toContain('169.254.1.1');
    });

    it('includes external IPv4 and IPv6 addresses', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const ips = addrs.map((a) => a.address);
      expect(ips).toContain('192.168.1.50');
      expect(ips).toContain('100.64.0.42');
      expect(ips).toContain('10.0.0.5');
      expect(ips).toContain('fd7a:115c:a1e0:ab12:4843:cd96:6246:9c2a');
    });

    it('sorts Tailscale addresses first', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const tailscaleIdx = addrs.findIndex((a) => a.tailscale);
      const otherIdx = addrs.findIndex((a) => !a.tailscale);
      expect(tailscaleIdx).toBeLessThan(otherIdx);
      expect(tailscaleIdx).toBeGreaterThanOrEqual(0);
    });

    it('detects Tailscale IPv4 CGNAT range (100.64.0.0/10)', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const ts = addrs.find((a) => a.address === '100.64.0.42');
      expect(ts).toBeDefined();
      expect(ts?.tailscale).toBe(true);
      expect(ts?.interface).toBe('tailscale0');
    });

    it('detects Tailscale IPv6 ULA prefix (fd7a:115c:a1e0:)', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const ts = addrs.find((a) => a.address === 'fd7a:115c:a1e0:ab12:4843:cd96:6246:9c2a');
      expect(ts).toBeDefined();
      expect(ts?.tailscale).toBe(true);
    });

    it('does not mark regular LAN addresses as Tailscale', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const lan = addrs.find((a) => a.address === '192.168.1.50');
      expect(lan?.tailscale).toBe(false);
    });

    it('sorts IPv4 before IPv6 within each group', () => {
      const addrs = getExternalAddresses(getInterfaces);
      const tsV4 = addrs.findIndex((a) => a.address === '100.64.0.42');
      const tsV6 = addrs.findIndex((a) => a.address === 'fd7a:115c:a1e0:ab12:4843:cd96:6246:9c2a');
      expect(tsV4).toBeLessThan(tsV6);
    });

    it('returns empty array when no external interfaces exist', () => {
      const empty: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
      expect(getExternalAddresses(() => empty)).toEqual([]);
    });
  });

  describe('formatExternalAccessUrls', () => {
    it('returns token-free URLs for wildcard IPv4 bind', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '0.0.0.0',
        port: 3456,
        getInterfaces,
      });
      expect(lines.length).toBeGreaterThan(0);
      const tsLine = lines.find((l) => l.includes('Tailscale'));
      expect(tsLine).toBeDefined();
      expect(tsLine).toContain('http://100.64.0.42:3456');
      expect(tsLine).not.toContain('token');
    });

    it('returns URLs for wildcard IPv6 bind', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '::',
        port: 3456,
        getInterfaces,
      });
      expect(lines.length).toBeGreaterThan(0);
      const v6Line = lines.find((l) => l.includes('[fd7a'));
      expect(v6Line).toBeDefined();
      expect(v6Line).toContain('http://[fd7a:115c:a1e0:');
    });

    it('returns empty array for loopback bind', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '127.0.0.1',
        port: 3456,
        getInterfaces,
      });
      expect(lines).toEqual([]);
    });

    it('returns empty array for specific LAN IP bind', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '192.168.1.50',
        port: 3456,
        getInterfaces,
      });
      expect(lines).toEqual([]);
    });

    it('brackets IPv6 addresses in URLs', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '0.0.0.0',
        port: 3456,
        getInterfaces,
      });
      const v6Line = lines.find((l) => l.includes('fd7a'));
      expect(v6Line).toContain('[fd7a:115c:a1e0:');
      expect(v6Line).not.toMatch(/http:\/\/fd7a.*:/); // no bare http://fd7a:
    });

    it('never includes authentication material in rendered URLs', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '0.0.0.0',
        port: 3456,
        getInterfaces,
      });
      for (const line of lines) {
        expect(line).not.toContain('token');
      }
    });

    it('returns empty array when no external addresses exist', () => {
      const empty: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
      const lines = formatExternalAccessUrls({
        bindHost: '0.0.0.0',
        port: 3456,
        getInterfaces: () => empty,
      });
      expect(lines).toEqual([]);
    });

    it('labels Tailscale interface by name, not interface name', () => {
      const lines = formatExternalAccessUrls({
        bindHost: '0.0.0.0',
        port: 3456,
        getInterfaces,
      });
      const tsLine = lines.find((l) => l.includes('100.64.0.42'));
      expect(tsLine).toContain('Tailscale');
      expect(tsLine).not.toContain('tailscale0');
    });
  });
});
