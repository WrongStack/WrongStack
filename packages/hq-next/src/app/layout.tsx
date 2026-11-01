import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono';
import '@xyflow/react/dist/style.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'WrongStack HQ',
  description: 'Machine-wide command center for WrongStack fleets.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/wrongstack.svg' },
  appleWebApp: { capable: true, title: 'HQ Mobile' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#e84a72',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
