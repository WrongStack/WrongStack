/**
 * Two-factor enrollment and removal.
 *
 * Enrollment is three phases — setup, verify, recovery codes — and the codes
 * phase is terminal on purpose: they are shown exactly once, so the only way
 * out is an explicit "I've saved them" that reloads the page.
 */
import { ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { PasswordInput } from '../../components/hq/password-input.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { authorizedFetch } from '../../data/api.js';
import { type BusySetter, errorMessage, type MessageSetter, toMessage } from './shared.js';

const TOTP_CODE_LENGTH = 6;
const QR_SIZE = 200;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, TOTP_CODE_LENGTH);
}

export function TotpEnroll({
  busy,
  setBusy,
  setMessage,
}: {
  busy: boolean;
  setBusy: BusySetter;
  setMessage: MessageSetter;
}): React.ReactElement {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'recovery'>('idle');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // Render the otpauth URI to a QR image. Failure is survivable — manual
  // secret entry still works — so a stale QR is cleared rather than kept.
  useEffect(() => {
    if (uri === '') {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(uri, { width: QR_SIZE, margin: 1, errorCorrectionLevel: 'M' })
      .then((url: string) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const setup = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/totp/setup', { method: 'POST' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { secret: string; uri: string };
      setSecret(body.secret);
      setUri(body.uri);
      setPhase('pending');
      setMessage({
        tone: 'ok',
        text: 'Add this secret to your authenticator app, then enter the 6-digit code below.',
      });
    } catch (cause) {
      setMessage(toMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (): Promise<void> => {
    if (verifyCode.length !== TOTP_CODE_LENGTH) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/totp/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { enabled: boolean; recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
      setPhase('recovery');
      setMessage({
        tone: 'ok',
        text: '2FA enabled. Save your recovery codes — they are shown only once.',
      });
    } catch (cause) {
      setMessage(toMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'idle') {
    return (
      <Button disabled={busy} onClick={() => void setup()}>
        <Smartphone />
        {busy ? 'Setting up…' : 'Start 2FA enrollment'}
      </Button>
    );
  }

  if (phase === 'pending') {
    return (
      <div className="space-y-3">
        {qrDataUrl !== '' && (
          <img
            src={qrDataUrl}
            alt="Scan this QR code with your authenticator app"
            width={QR_SIZE}
            height={QR_SIZE}
            className="border border-border bg-white p-1"
          />
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Secret (manual entry):</span>
          <code className="border border-border bg-muted px-1.5 py-0.5 font-mono">{secret}</code>
        </div>

        <div className="space-y-1">
          <Label htmlFor="hq-totp-verify">Verification code</Label>
          <Input
            id="hq-totp-verify"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={TOTP_CODE_LENGTH}
            placeholder="000000"
            autoComplete="one-time-code"
            value={verifyCode}
            onChange={(event) => setVerifyCode(digitsOnly(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void enable();
            }}
            className="w-40 font-mono"
          />
        </div>

        <Button
          disabled={verifyCode.length !== TOTP_CODE_LENGTH || busy}
          onClick={() => void enable()}
        >
          <ShieldCheck />
          {busy ? 'Enabling…' : 'Confirm and enable 2FA'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 border border-warning/40 bg-warning/5 p-3">
        <p className="text-xs font-semibold">Recovery codes</p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-[11px]">
          {recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Store these somewhere safe. Each can be used once instead of a TOTP code if you lose your
          device.
        </p>
      </div>
      <Button onClick={() => window.location.reload()}>
        <ShieldCheck />
        I&apos;ve saved my recovery codes
      </Button>
    </div>
  );
}

export function TotpDisable({
  busy,
  setBusy,
  setMessage,
  hasPassword,
}: {
  busy: boolean;
  setBusy: BusySetter;
  setMessage: MessageSetter;
  hasPassword: boolean;
}): React.ReactElement {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirming, setConfirming] = useState(false);

  // With a password set, the password is the second factor for this action;
  // without one, only a live TOTP code proves possession of the device.
  const canDisable = hasPassword ? password.length > 0 : totpCode.length === TOTP_CODE_LENGTH;

  const disable = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const payload: Record<string, string> = {};
      if (password !== '') payload.password = password;
      if (totpCode !== '') payload.code = totpCode;
      const response = await authorizedFetch('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setMessage({ tone: 'ok', text: '2FA disabled.' });
      setPassword('');
      setTotpCode('');
      setConfirming(false);
      window.location.reload();
    } catch (cause) {
      setMessage(toMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <Button variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>
        <ShieldOff />
        Disable 2FA
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      {hasPassword ? (
        <div className="space-y-1">
          <Label htmlFor="hq-totp-disable-password">Current password</Label>
          <PasswordInput
            id="hq-totp-disable-password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            placeholder="confirm with password"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canDisable) void disable();
            }}
            className="max-w-sm"
          />
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="hq-totp-disable-code">Authenticator code</Label>
          <Input
            id="hq-totp-disable-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={TOTP_CODE_LENGTH}
            placeholder="000000"
            autoComplete="one-time-code"
            value={totpCode}
            onChange={(event) => setTotpCode(digitsOnly(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canDisable) void disable();
            }}
            className="w-40 font-mono"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={!canDisable || busy} onClick={() => void disable()}>
          <ShieldOff />
          Confirm disable
        </Button>
      </div>
    </div>
  );
}
