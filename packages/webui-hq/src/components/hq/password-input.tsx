import { Eye, EyeOff } from 'lucide-react';
import type * as React from 'react';
import { useId, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from '../ui/input.js';

/**
 * Secret input with a reveal toggle.
 *
 * The toggle is `tabIndex={-1}`: Tab from the field should reach the submit
 * button, not a decoration. `autoComplete` is a required prop rather than a
 * default, because getting it wrong makes password managers either miss the
 * field or offer a saved password for a one-time token.
 */
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  inputRef,
  onKeyDown,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  id?: string;
  className?: string;
}): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  const generatedId = useId();

  return (
    <div className={cn('relative', className)}>
      <Input
        ref={inputRef}
        id={id ?? generatedId}
        type={revealed ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="pr-9 font-mono"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        title={revealed ? 'Hide' : 'Reveal'}
        onClick={() => setRevealed((current) => !current)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
      >
        {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}
