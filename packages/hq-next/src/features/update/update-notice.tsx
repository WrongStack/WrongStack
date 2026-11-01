'use client';

/**
 * Header chip shown when the HQ server reports a newer WrongStack release.
 * Opening it explains how to update and copies the command; it never runs
 * anything. The check is advisory: a failed fetch shows nothing.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hq/components/ui/dropdown-menu';
import { fetchJson } from '@hq/data/api';
import { ArrowUpCircle, Check, Copy, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { type HqUpdateStatus, UPDATE_POLL_MS, type UpdateNotice, updateNotice } from './model';

const RELEASES_URL = 'https://github.com/WrongStack/WrongStack/releases';

function useUpdateNotice(): UpdateNotice | null {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<HqUpdateStatus>('/api/system/update')
        .then((status) => {
          if (!cancelled) setNotice(updateNotice(status));
        })
        .catch(() => {
          // Advisory only: an unreachable registry must never block HQ.
        });
    };
    load();
    const timer = window.setInterval(load, UPDATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return notice;
}

export function UpdateNoticeChip(): ReactNode {
  const notice = useUpdateNotice();
  const [copied, setCopied] = useState(false);
  if (notice === null) return null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(notice.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard can be denied (insecure origin); the command stays visible.
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        data-testid="update-notice"
        aria-label={`WrongStack ${notice.latest} is available`}
        className="hidden h-9 items-center gap-1.5 border border-warning/40 bg-warning/10 px-2.5 text-sm text-warning hover:bg-warning/20 md:inline-flex"
      >
        <ArrowUpCircle className="size-4" />
        {notice.latest}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex flex-col gap-1 py-2">
          <span className="text-sm font-semibold">Update available</span>
          <span className="text-sm font-normal text-muted-foreground">
            This HQ runs {notice.current}; {notice.latest} is out. Update the machine running HQ,
            then restart it.
          </span>
          <code className="mt-1 border border-border bg-muted px-2 py-1 font-mono text-xs">
            {notice.command}
          </code>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void copy();
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy the command'}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
            <ExternalLink className="size-4" />
            Release notes
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
