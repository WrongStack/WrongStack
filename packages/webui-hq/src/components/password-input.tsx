import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
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
  inputRef,
  placeholder,
  autoComplete,
  minLength,
  maxLength,
  className,
  id,
}: PasswordInputProps): React.ReactElement {
  const [visible, setVisible] = useState(false);

  return (
    <div className="hq-password-input-wrapper">
      <input
        ref={inputRef}
        id={id}
        type={visible ? 'text' : 'password'}
        className={className ?? 'hq-token-input'}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="hq-password-toggle"
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
