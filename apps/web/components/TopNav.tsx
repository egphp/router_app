'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, Activity, AlertTriangle, Cog, LayoutDashboard, ListTree } from 'lucide-react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';

const nav = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/devices', label: 'Devices', icon: ListTree },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/outages', label: 'Outages', icon: AlertTriangle },
  { href: '/settings', label: 'Settings', icon: Cog },
];

export function TopNav() {
  const pathname = usePathname();
  const { data: status } = useSWR<{ connected: boolean; alerts: number; last_sample_ts: number | null }>(
    '/api/status', fetcher, { refreshInterval: 5000 }
  );
  const connected = status?.connected ?? false;
  const alerts = status?.alerts ?? 0;

  return (
    <header className="border-b border-bg-border bg-bg-card/50 backdrop-blur sticky top-0 z-30">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-6">
        <div className="flex items-center gap-2 font-semibold">
          <Activity size={18} className="text-accent" />
          <span>Tenda Monitor</span>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          {nav.map((item) => {
            const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href} href={item.href}
                className={`px-3 py-1.5 rounded-md flex items-center gap-2 transition ${
                  active ? 'bg-bg-elevated text-slate-100' : 'text-slate-400 hover:text-slate-100 hover:bg-bg-elevated/50'
                }`}>
                <Icon size={14} />
                <span>{item.label}</span>
                {item.label === 'Alerts' && alerts > 0 && (
                  <span className="ml-1 text-[10px] bg-accent-red text-white rounded-full px-1.5 py-0.5 font-semibold">{alerts}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-accent-green animate-pulse-slow' : 'bg-accent-red'}`}></span>
          <span>{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}
