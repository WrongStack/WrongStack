import type { ReactNode } from 'react';
import { HqRuntime } from '@/components/hq-runtime';
import { MobileShell } from '@/components/mobile-shell';

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <HqRuntime surface="mobile">
      <MobileShell>{children}</MobileShell>
    </HqRuntime>
  );
}
