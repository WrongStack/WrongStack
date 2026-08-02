import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  autoFocus?: boolean;
  className?: string;
  id?: string;
}

/**
 * Password input with a show/hide toggle button. Renders as a standard
 * password field by default; clicking the eye icon reveals the text.
 */
export function PasswordInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoComplete,
  minLength,
  maxLength,
  autoFocus,
  className,
  id,
}: PasswordInputProps): React.ReactElement {
  const [visible, setVisible] = useState(false);

  return (
    <div className="hq-password-input-wrapper">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        className={className ?? 'hq-token-input'}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
        autoFocus={autoFocus}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="hq-password-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
