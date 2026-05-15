import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '../components/TopNav';

export const metadata: Metadata = {
  title: 'Tenda Monitor',
  description: 'Per-device bandwidth, traffic history, and alerts for your Tenda router',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6">{children}</main>
      </body>
    </html>
  );
}
