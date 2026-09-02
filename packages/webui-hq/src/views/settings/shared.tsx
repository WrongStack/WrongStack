/** Types and small pieces shared by the Security page's panels. */
import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { Card, CardContent } from '../../components/ui/card.js';
import { scorePassword } from '../../domain/password-strength.js';
import { cn } from '../../lib/utils.js';

export interface AuthStatus {
  tokenMode: boolean;
  passwordMode: boolean;
  totpEnabled?: boolean | undefined;
  recoveryCodesRemaining?: number | undefined;
  loggedIn: boolean;
  authKind?: 'token' | 'password' | 'open' | undefined;
  publicRelay?: boolean | undefined;
  publicOrigin?: string | undefined;
  secureCookies?: boolean | undefined;
}

export type PanelMessage = { tone: 'ok' | 'error'; text: string };
export type MessageSetter = (message: PanelMessage | null) => void;
export type BusySetter = (busy: boolean) => void;

/** Prefer the server's own error text; fall back to the status line. */
export async function errorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    if (typeof body.error === 'string') return body.error;
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function toMessage(cause: unknown): PanelMessage {
  return { tone: 'error', text: cause instanceof Error ? cause.message : String(cause) };
}

export function StatusMessage({
  message,
}: {
  message: PanelMessage | null;
}): React.ReactElement | null {
  if (message === null || message.text === '') return null;
  return (
    <p
      role="status"
      data-testid="settings-message"
      data-tone={message.tone}
      className={cn(
        'border px-2 py-1.5 text-[11px]',
        message.tone === 'error'
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-success/40 bg-success/5 text-success',
      )}
    >
      {message.text}
    </p>
  );
}

export function SecurityPanel({
  eyebrow,
  title,
  description,
  icon: Icon,
  danger = false,
  children,
}: {
  eyebrow: string;
  title: string;
  description: React.ReactNode;
  icon: LucideIcon;
  danger?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className={danger ? 'border-destructive/40' : undefined}>
      <div className="flex items-start gap-3 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
            {eyebrow}
          </span>
          <h2 className="font-display text-sm font-semibold">{title}</h2>
          <p className="max-w-prose text-[11px] text-muted-foreground">{description}</p>
        </div>
        <Icon
          className={cn('size-5 shrink-0', danger ? 'text-destructive' : 'text-muted-foreground')}
        />
      </div>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

const STRENGTH_BAR: Record<string, string> = {
  weak: 'bg-destructive',
  fair: 'bg-warning',
  good: 'bg-info',
  strong: 'bg-success',
};

export function PasswordStrengthMeter({
  password,
}: {
  password: string;
}): React.ReactElement | null {
  const { level, score, label } = scorePassword(password);
  if (level === 'empty') return null;
  return (
    <div data-testid="password-strength" data-level={level} className="flex items-center gap-2">
      <div className="h-1 flex-1 bg-secondary">
        <div
          className={cn('h-full transition-[width]', STRENGTH_BAR[level] ?? 'bg-muted-foreground')}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="w-12 text-right text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
