import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tenda Monitor',
    short_name: 'Tenda',
    description: 'Per-device bandwidth, attack log, syslog viewer for Tenda W30E',
    start_url: '/',
    display: 'standalone',
    background_color: '#13162a',
    theme_color: '#13162a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: '/icon-384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
