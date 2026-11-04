import { Server } from 'lucide-react';
import { useState } from 'react';
import { resolveProviderBrand } from '../lib/provider-brand';
import { cn } from '../lib/utils';

/** Decorative next to the provider's visible name; original brand colors in both themes. */
export function ProviderLogo({
  providerId,
  baseUrl,
  providerType,
  className,
}: {
  providerId: string;
  baseUrl?: string | undefined;
  providerType?: string | undefined;
  className?: string;
}) {
  const brand = resolveProviderBrand(providerId, baseUrl, providerType);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      data-provider-brand={brand?.id ?? 'custom'}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border p-1.5 shadow-sm',
        brand?.id === 'kimi'
          ? 'border-white/10 bg-zinc-950 text-white'
          : 'border-black/10 bg-white text-zinc-900',
        className,
      )}
    >
      {brand && failedSource !== brand.src ? (
        <img
          src={brand.src}
          alt=""
          draggable={false}
          className="h-full w-full object-contain"
          onError={() => setFailedSource(brand.src)}
        />
      ) : (
        <Server className="h-5 w-5" />
      )}
    </span>
  );
}
