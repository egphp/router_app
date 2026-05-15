import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '../components/TopNav';

export const metadata: Metadata = {
  title: 'Tenda Monitor',
  description: 'Per-device bandwidth, traffic history, and alerts for your Tenda router',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Tenda Monitor',
    statusBarStyle: 'black-translucent',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <TopNav />
        <main className="max-w-[1600px] mx-auto px-3 sm:px-4 lg:px-6 xl:px-8 py-4 sm:py-5 lg:py-6">{children}</main>
      </body>
    </html>
  );
}
