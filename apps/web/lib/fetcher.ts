export const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 401) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
    throw new Error('biometric passkey login required');
  }
  return res.json();
};
