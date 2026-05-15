'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Bell, Activity, AlertTriangle, Cog, LayoutDashboard, ListTree, BarChart3, Shield,
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
  const isSetup = pathname === '/setup';
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
      <header className="border-b border-bg-border bg-bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto h-12 sm:h-14 px-3 sm:px-4 lg:px-6 flex items-center gap-2 sm:gap-3 xl:gap-4">
          {/* Hamburger — visible below xl (1280) */}
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="xl:hidden p-2 -ml-2 rounded-md hover:bg-bg-elevated text-slate-300 shrink-0"
          >
            <Menu size={20} />
          </button>

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 font-semibold shrink-0">
            <Activity size={18} className="text-accent shrink-0" />
            <span className="text-sm sm:text-base whitespace-nowrap">Tenda Monitor</span>
          </Link>

          {/* Desktop nav — visible only xl and up */}
          <nav className="hidden xl:flex items-center gap-0.5 text-sm flex-1 min-w-0 overflow-x-auto scrollbar-thin">
            {nav.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href} href={item.href}
                  className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 shrink-0 transition whitespace-nowrap ${
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-bg-elevated/60'
                  }`}>
                  <Icon size={14} className="shrink-0" />
                  <span>{item.label}</span>
                  {item.label === 'Alerts' && alerts > 0 && (
                    <span className="ml-0.5 text-[10px] bg-accent-red text-white rounded-full px-1.5 py-0.5 font-semibold leading-none">{alerts}</span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Right side — pushed right with ml-auto on smaller, fills space on xl */}
          <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Mobile alerts shortcut */}
            {alerts > 0 && (
              <Link
                href="/alerts"
                aria-label={`${alerts} active alerts`}
                className="xl:hidden relative p-1.5 rounded-md hover:bg-bg-elevated text-slate-300"
              >
                <Bell size={18} />
                <span className="absolute -top-0.5 -right-0.5 text-[10px] bg-accent-red text-white rounded-full min-w-[16px] h-4 px-1 font-bold leading-4 text-center">
                  {alerts}
                </span>
              </Link>
            )}

            {/* Connection pill — full label on sm+, dot only on xs */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400 px-2 py-1 rounded-md bg-bg-elevated/60 border border-bg-border">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-accent-green animate-pulse-slow' : 'bg-accent-red'}`} />
              <span className="font-medium">{connected ? 'Live' : 'Offline'}</span>
            </div>
            <span
              aria-label={connected ? 'Connected' : 'Offline'}
              className={`sm:hidden w-2 h-2 rounded-full ${connected ? 'bg-accent-green' : 'bg-accent-red'}`}
            />
          </div>
        </div>
      </header>

      {/* Drawer */}
      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 xl:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-bg-card border-r border-bg-border z-50 xl:hidden overflow-y-auto animate-fade-in flex flex-col">
            <div className="flex items-center justify-between px-4 h-12 border-b border-bg-border shrink-0">
              <div className="flex items-center gap-2 font-semibold">
                <Activity size={18} className="text-accent" />
                <span>Tenda Monitor</span>
              </div>
              <button
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-md hover:bg-bg-elevated text-slate-300"
              >
                <X size={20} />
              </button>
            </div>
            <nav className="p-2 space-y-0.5 flex-1">
              {nav.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href} href={item.href}
                    className={`px-3 py-2.5 rounded-md flex items-center gap-3 text-sm ${
                      active
                        ? 'bg-accent/15 text-accent border border-accent/30'
                        : 'text-slate-300 hover:bg-bg-elevated'
                    }`}>
                    <Icon size={16} className="shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {item.label === 'Alerts' && alerts > 0 && (
                      <span className="text-[10px] bg-accent-red text-white rounded-full px-1.5 py-0.5 font-semibold leading-none">{alerts}</span>
                    )}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-bg-border px-4 py-3 text-xs text-slate-400 flex items-center gap-2 shrink-0">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-accent-green animate-pulse-slow' : 'bg-accent-red'}`} />
              <span>{connected ? 'Connected · Live' : 'Disconnected'}</span>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
