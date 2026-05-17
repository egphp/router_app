'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Bell, AlertTriangle, Cog, LayoutDashboard, ListTree, BarChart3, Shield,
  Receipt, Calendar, ShieldAlert, Network, Download, Menu, X,
} from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';

const nav = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/devices', label: 'Devices', icon: ListTree },
  { href: '/map', label: 'Map', icon: Network },
  { href: '/consumption', label: 'Consumption', icon: Receipt },
  { href: '/report', label: 'Report', icon: Calendar },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/security', label: 'Security', icon: Shield },
  { href: '/attacks', label: 'Attacks', icon: ShieldAlert },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/outages', label: 'Outages', icon: AlertTriangle },
  { href: '/export', label: 'Export', icon: Download },
  { href: '/settings', label: 'Settings', icon: Cog },
];

export function TopNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isSetup = pathname === '/setup' || pathname === '/login';
  const { data: status } = useSWR<{ connected: boolean; alerts: number }>(
    isSetup ? null : '/api/status', fetcher, { refreshInterval: 5000 }
  );
  const connected = status?.connected ?? false;
  const alerts = status?.alerts ?? 0;

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const isActive = (href: string) =>
    pathname === href || (href !== '/' && pathname.startsWith(href));

  if (isSetup) return null;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-bg-border/60 backdrop-blur-xl"
        style={{ background: 'linear-gradient(180deg, oklch(0.20 0.04 275 / 0.85) 0%, oklch(0.20 0.04 275 / 0.7) 100%)' }}>
        <div className="max-w-[1600px] mx-auto h-14 sm:h-16 px-3 sm:px-5 lg:px-7 flex items-center gap-2 sm:gap-3 xl:gap-5">
          {/* Hamburger */}
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="2xl:hidden p-2 -ml-2 rounded-xl hover:bg-bg-elevated/60 text-text-secondary shrink-0 transition"
          >
            <Menu size={20} />
          </button>

          {/* Logo — Aurora monogram + display wordmark */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
            <img
              src="/icon-64.png"
              alt="Tenda Monitor"
              width={32}
              height={32}
              className="rounded-lg shrink-0"
              style={{ boxShadow: '0 4px 14px -4px oklch(0.82 0.13 50 / 0.4)' }}
            />
            <span className="font-display text-base sm:text-lg font-semibold tracking-tight whitespace-nowrap">
              <span className="text-text-primary">Tenda</span>
              <span className="text-accent-peach italic"> Monitor</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden 2xl:flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin ml-2">
            {nav.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href} href={item.href}
                  className={active ? 'nav-link active flex items-center gap-1.5 whitespace-nowrap' : 'nav-link flex items-center gap-1.5 whitespace-nowrap'}>
                  <Icon size={14} className="shrink-0" />
                  <span>{item.label}</span>
                  {item.label === 'Alerts' && alerts > 0 && (
                    <span className="ml-1 text-[10px] rounded-full px-1.5 py-0.5 font-semibold leading-none"
                      style={{ background: active ? 'oklch(0.20 0.04 275 / 0.2)' : 'var(--coral-soft)', color: active ? 'oklch(0.20 0.04 275)' : 'var(--coral)' }}>
                      {alerts}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
            {alerts > 0 && (
              <Link
                href="/alerts"
                aria-label={`${alerts} active alerts`}
                className="2xl:hidden relative p-2 rounded-xl hover:bg-bg-elevated/60 text-text-secondary transition"
              >
                <Bell size={18} />
                <span className="absolute -top-0.5 -right-0.5 text-[10px] rounded-full min-w-[16px] h-4 px-1 font-bold leading-4 text-center"
                  style={{ background: 'var(--coral)', color: 'oklch(0.20 0.04 275)' }}>
                  {alerts}
                </span>
              </Link>
            )}

            <div className="hidden sm:flex items-center gap-2 text-xs px-3 py-1.5 rounded-full"
              style={{ background: connected ? 'var(--mint-soft)' : 'var(--coral-soft)', border: `1.5px solid ${connected ? 'oklch(0.85 0.13 165 / 0.35)' : 'oklch(0.74 0.18 25 / 0.35)'}` }}>
              <span className={connected ? 'live-dot' : 'w-1.5 h-1.5 rounded-full bg-accent-coral'} />
              <span className="font-medium" style={{ color: connected ? 'var(--mint)' : 'var(--coral)' }}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </div>
            <span
              aria-label={connected ? 'Connected' : 'Offline'}
              className={`sm:hidden w-2 h-2 rounded-full ${connected ? 'bg-accent-mint' : 'bg-accent-coral'}`}
            />
          </div>
        </div>
      </header>

      {/* Drawer */}
      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 2xl:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 w-72 max-w-[85vw] z-50 2xl:hidden overflow-y-auto animate-slide-up flex flex-col"
            style={{ background: 'var(--bg-card)', borderRight: '1.5px solid var(--border)' }}>
            <div className="flex items-center justify-between px-4 h-14 shrink-0" style={{ borderBottom: '1.5px solid var(--border)' }}>
              <div className="flex items-center gap-2.5">
                <img
                  src="/icon-64.png"
                  alt="Tenda Monitor"
                  width={28}
                  height={28}
                  className="rounded-lg"
                />
                <span className="font-display text-base font-semibold">
                  <span className="text-text-primary">Tenda</span>
                  <span className="text-accent-peach italic"> Monitor</span>
                </span>
              </div>
              <button
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-xl hover:bg-bg-elevated text-text-secondary"
              >
                <X size={20} />
              </button>
            </div>
            <nav className="p-3 space-y-1 flex-1">
              {nav.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href} href={item.href}
                    className={active ? 'nav-link active flex items-center gap-3 text-sm py-2.5 px-3' : 'nav-link flex items-center gap-3 text-sm py-2.5 px-3'}>
                    <Icon size={16} className="shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {item.label === 'Alerts' && alerts > 0 && (
                      <span className="chip chip-coral text-[10px] px-2 py-0">{alerts}</span>
                    )}
                  </Link>
                );
              })}
            </nav>
            <div className="px-4 py-3 text-xs flex items-center gap-2.5 shrink-0" style={{ borderTop: '1.5px solid var(--border)' }}>
              <span className={connected ? 'live-dot' : 'w-2 h-2 rounded-full bg-accent-coral'} />
              <span className="font-medium" style={{ color: connected ? 'var(--mint)' : 'var(--coral)' }}>
                {connected ? 'Connected · Live' : 'Disconnected'}
              </span>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
