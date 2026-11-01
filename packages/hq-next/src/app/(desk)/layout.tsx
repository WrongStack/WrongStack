import type { ReactNode } from 'react';
import { HqRuntime } from '@/components/hq-runtime';
import { HqShell } from '@/components/shell';

export default function DeskLayout({ children }: { children: ReactNode }) {
  return (
    <HqRuntime surface="desktop">
      <HqShell>{children}</HqShell>
    </HqRuntime>
  );
}
