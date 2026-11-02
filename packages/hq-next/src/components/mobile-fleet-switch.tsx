'use client';

/**
 * The Fleet tab on the phone holds two lists: machines and projects. This is
 * the switch between them, two links so the browser history and the
 * installed app's back gesture follow it.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const VIEWS = [
  { key: 'machines', href: '/mobile/fleet/', label: 'Machines' },
  { key: 'projects', href: '/mobile/fleet/projects/', label: 'Projects' },
] as const;

export function MobileFleetSwitch({ current }: { current: 'machines' | 'projects' }): ReactNode {
  return (
    <nav aria-label="Fleet lists" className="grid grid-cols-2 border border-border">
      {VIEWS.map((view) => (
        <Link
          key={view.key}
          href={view.href}
          aria-current={view.key === current ? 'page' : undefined}
          className={cn(
            'flex h-10 items-center justify-center text-sm font-medium',
            view.key === current ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
