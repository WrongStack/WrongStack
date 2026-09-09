import { BlockList, isIP } from 'node:net';

export interface HqIpAllowlist {
  readonly entries: readonly string[];
  allows(address: string | undefined): boolean;
}

function normalizeAddress(value: string): string {
  return value
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/^::ffff:/i, '');
}

function addRule(blockList: BlockList, rawRule: string): string {
  const rule = rawRule.trim();
  if (!rule) throw new TypeError('HQ IP allowlist contains an empty entry.');
  const slash = rule.lastIndexOf('/');
  if (slash === -1) {
    const address = normalizeAddress(rule);
    const family = isIP(address);
    if (family === 0) {
      throw new TypeError(`Invalid HQ allowlist address: ${rule}`);
    }
    blockList.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
    return address;
  }

  const address = normalizeAddress(rule.slice(0, slash));
  const prefixText = rule.slice(slash + 1);
  const family = isIP(address);
  if (family === 0 || !/^\d+$/.test(prefixText)) {
    throw new TypeError(`Invalid HQ allowlist network: ${rule}`);
  }
  const prefix = Number(prefixText);
  const maximum = family === 4 ? 32 : 128;
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > maximum) {
    throw new TypeError(`Invalid HQ allowlist prefix: ${rule}`);
  }
  blockList.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  return `${address}/${prefix}`;
}

/**
 * Build the optional HQ admission allowlist.
 *
 * Matching is intentionally performed against the TCP peer, never a forwarded
 * header. When HQ is directly reachable on 0.0.0.0, trusting a client-supplied
 * X-Forwarded-For value here would turn the allowlist into a bypass. Loopback
 * remains implicit so local administration and health checks cannot be locked
 * out by a remote-only list.
 */
export function createHqIpAllowlist(
  rules: readonly string[] | undefined,
): HqIpAllowlist | undefined {
  if (rules === undefined || rules.length === 0) return undefined;
  const blockList = new BlockList();
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addAddress('::1', 'ipv6');
  const entries = [...new Set(rules.map((rule) => addRule(blockList, rule)))];

  return {
    entries,
    allows(address) {
      if (!address) return false;
      const normalized = normalizeAddress(address);
      const family = isIP(normalized);
      if (family === 0) return false;
      return blockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

export function parseHqIpAllowlist(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const rules = value.split(',').map((entry) => entry.trim());
  // Construct once here so CLI/config errors fail before the listener binds.
  createHqIpAllowlist(rules);
  return rules;
}
