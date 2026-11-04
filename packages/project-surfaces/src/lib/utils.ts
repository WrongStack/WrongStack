import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Browser-safe UUID generation. `crypto.randomUUID()` is only available in
 * secure contexts (HTTPS or localhost). In non-secure contexts (plain HTTP)
 * it is `undefined`, and calling it throws TypeError (#415: WebUI opened over
 * plain HTTP from a LAN address). The fallback builds an RFC 4122 v4 UUID
 * from `crypto.getRandomValues`, which secure and non-secure contexts both
 * expose, so ids keep the same shape wherever they are stored or echoed back.
 * Math.random only fills in when no Web Crypto exists at all.
 */
export function safeId(): string {
  const webCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
