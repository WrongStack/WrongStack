const DISCOVERY_LIMIT = 25;
const MAX_PRESENTED_CANDIDATES = 10;

interface TelegramPairingUser {
  id: number;
  is_bot: boolean;
}

interface TelegramPairingChat {
  id: number;
  type: string;
}

interface TelegramPairingMessage {
  from?: TelegramPairingUser | undefined;
  chat: TelegramPairingChat;
}

export interface TelegramPairingUpdate {
  update_id: number;
  message?: TelegramPairingMessage | undefined;
  edited_message?: TelegramPairingMessage | undefined;
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramPairingUpdate[] | undefined;
}

type TelegramPairingChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';

export interface TelegramPairingCandidate {
  chatId: number;
  userId: number;
  chatType: TelegramPairingChatType;
  updateId: number;
  eligible: boolean;
  warning?: 'group' | 'ambiguous' | undefined;
}

type TelegramPairingChoice =
  | { kind: 'cancel' }
  | { kind: 'invalid' }
  | { kind: 'selected'; candidate: TelegramPairingCandidate };

/**
 * Reduce Telegram updates to identity metadata only. Message text, names, and
 * usernames never enter the pairing surface, so untrusted content cannot be
 * reflected into the terminal during setup.
 */
function normalizeChatType(value: string): TelegramPairingChatType {
  return value === 'private' || value === 'group' || value === 'supergroup' || value === 'channel'
    ? value
    : 'unknown';
}

export function extractTelegramPairingCandidates(
  updates: readonly TelegramPairingUpdate[],
): TelegramPairingCandidate[] {
  const byIdentity = new Map<string, Omit<TelegramPairingCandidate, 'eligible' | 'warning'>>();
  const usersByChat = new Map<number, Set<number>>();

  for (const update of updates) {
    const message = update.message ?? update.edited_message;
    const from = message?.from;
    if (!message || !from || from.is_bot) continue;
    if (!Number.isSafeInteger(update.update_id)) continue;
    if (!Number.isSafeInteger(message.chat.id) || !Number.isSafeInteger(from.id)) continue;

    const key = `${message.chat.id}:${from.id}`;
    const current = byIdentity.get(key);
    if (!current || update.update_id > current.updateId) {
      byIdentity.set(key, {
        chatId: message.chat.id,
        userId: from.id,
        chatType: normalizeChatType(message.chat.type),
        updateId: update.update_id,
      });
    }

    const users = usersByChat.get(message.chat.id) ?? new Set<number>();
    users.add(from.id);
    usersByChat.set(message.chat.id, users);
  }

  return [...byIdentity.values()]
    .sort((left, right) => right.updateId - left.updateId)
    .slice(0, MAX_PRESENTED_CANDIDATES)
    .map((candidate) => {
      const privateIdentityMatches =
        candidate.chatType === 'private' && candidate.chatId === candidate.userId;
      const uniqueUser = usersByChat.get(candidate.chatId)?.size === 1;
      if (
        candidate.chatType === 'group' ||
        candidate.chatType === 'supergroup' ||
        candidate.chatType === 'channel'
      ) {
        return { ...candidate, eligible: false, warning: 'group' as const };
      }
      if (!privateIdentityMatches || !uniqueUser) {
        return { ...candidate, eligible: false, warning: 'ambiguous' as const };
      }
      return { ...candidate, eligible: true };
    });
}

/** Fetch a bounded recent-update window. The credential-bearing URL is internal only. */
export async function discoverTelegramPairingCandidates(
  botToken: string,
): Promise<TelegramPairingCandidate[]> {
  const params = new URLSearchParams({
    limit: String(DISCOVERY_LIMIT),
    timeout: '0',
  });
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/getUpdates?${params.toString()}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const payload = (await response.json()) as TelegramUpdatesResponse;
  if (!payload.ok || !Array.isArray(payload.result)) {
    throw new Error('Telegram chat discovery failed.');
  }
  return extractTelegramPairingCandidates(payload.result);
}

export function formatTelegramPairingCandidates(
  candidates: readonly TelegramPairingCandidate[],
): string {
  return candidates
    .map((candidate, index) => {
      const base = `${index + 1}. ${candidate.chatType} chat_id=${candidate.chatId} user_id=${candidate.userId}`;
      if (candidate.warning === 'group') {
        return `${base}  ⚠ shared/group target — not eligible for automatic pairing`;
      }
      if (candidate.warning === 'ambiguous') {
        return `${base}  ⚠ identity mismatch — not eligible for automatic pairing`;
      }
      return `${base}  ✓ private pairing candidate`;
    })
    .join('\n');
}

export function parseTelegramPairingChoice(
  input: string,
  candidates: readonly TelegramPairingCandidate[],
): TelegramPairingChoice {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'cancel') return { kind: 'cancel' };
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };

  const index = Number(trimmed) - 1;
  const candidate = candidates[index];
  return candidate ? { kind: 'selected', candidate } : { kind: 'invalid' };
}
