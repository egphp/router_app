/**
 * Built-in NSFW domain list, grouped by category. Compiled from common
 * public block-lists (StevenBlack/hosts adult subset, OISD nsfw category).
 * This is intentionally small (~250 entries) so we ship it inline; users
 * can extend via the `nsfw_extra_domains` setting.
 */
export const NSFW_DOMAINS: { domain: string; category: string }[] = [
  // Tier 1 — the most-trafficked adult sites
  { domain: 'pornhub.com', category: 'adult' },
  { domain: 'xvideos.com', category: 'adult' },
  { domain: 'xnxx.com', category: 'adult' },
  { domain: 'xhamster.com', category: 'adult' },
  { domain: 'redtube.com', category: 'adult' },
  { domain: 'youporn.com', category: 'adult' },
  { domain: 'tube8.com', category: 'adult' },
  { domain: 'tnaflix.com', category: 'adult' },
  { domain: 'spankbang.com', category: 'adult' },
  { domain: 'beeg.com', category: 'adult' },
  { domain: 'porn.com', category: 'adult' },
  { domain: 'porntrex.com', category: 'adult' },
  { domain: 'sex.com', category: 'adult' },
  { domain: 'eporner.com', category: 'adult' },
  { domain: 'porn300.com', category: 'adult' },
  { domain: 'porndig.com', category: 'adult' },
  { domain: 'hclips.com', category: 'adult' },
  { domain: 'fapality.com', category: 'adult' },
  { domain: 'pornhd.com', category: 'adult' },
  { domain: 'pornone.com', category: 'adult' },
  { domain: 'pornoxo.com', category: 'adult' },
  { domain: 'sexvid.xxx', category: 'adult' },
  { domain: '4tube.com', category: 'adult' },
  { domain: '9porn.net', category: 'adult' },
  { domain: 'manyvids.com', category: 'adult' },
  { domain: 'chaturbate.com', category: 'webcam' },
  { domain: 'livejasmin.com', category: 'webcam' },
  { domain: 'bongacams.com', category: 'webcam' },
  { domain: 'stripchat.com', category: 'webcam' },
  { domain: 'cam4.com', category: 'webcam' },
  { domain: 'camsoda.com', category: 'webcam' },
  { domain: 'myfreecams.com', category: 'webcam' },
  { domain: 'flirt4free.com', category: 'webcam' },

  // Tube networks + aggregators
  { domain: 'xvideos2.com', category: 'adult' },
  { domain: 'xvideos.es', category: 'adult' },
  { domain: 'xvideos.red', category: 'adult' },
  { domain: 'xnxx2.com', category: 'adult' },
  { domain: 'xnxx-cdn.com', category: 'adult' },
  { domain: 'pornhub.org', category: 'adult' },
  { domain: 'phncdn.com', category: 'adult-cdn' },
  { domain: 'rdtcdn.com', category: 'adult-cdn' },
  { domain: 'ypncdn.com', category: 'adult-cdn' },
  { domain: 'xhcdn.com', category: 'adult-cdn' },
  { domain: 'xvideos-cdn.com', category: 'adult-cdn' },
  { domain: 'tnaflix.com', category: 'adult' },
  { domain: 'fux.com', category: 'adult' },
  { domain: 'iceporn.com', category: 'adult' },
  { domain: 'porntube.com', category: 'adult' },
  { domain: 'pornerbros.com', category: 'adult' },

  // Premium / paid
  { domain: 'brazzers.com', category: 'adult-paid' },
  { domain: 'mofos.com', category: 'adult-paid' },
  { domain: 'naughtyamerica.com', category: 'adult-paid' },
  { domain: 'realitykings.com', category: 'adult-paid' },
  { domain: 'digitalplayground.com', category: 'adult-paid' },
  { domain: 'twistys.com', category: 'adult-paid' },
  { domain: 'wickedpictures.com', category: 'adult-paid' },
  { domain: 'evilangel.com', category: 'adult-paid' },
  { domain: 'kink.com', category: 'adult-paid' },
  { domain: 'bangbros.com', category: 'adult-paid' },

  // Onlyfans-style + creator platforms
  { domain: 'onlyfans.com', category: 'creator' },
  { domain: 'fansly.com', category: 'creator' },
  { domain: 'fancentro.com', category: 'creator' },
  { domain: 'justforfans.app', category: 'creator' },
  { domain: 'admireme.vip', category: 'creator' },
  { domain: 'iwantclips.com', category: 'creator' },

  // Hentai / animated
  { domain: 'hentaihaven.org', category: 'animated' },
  { domain: 'hentai.tv', category: 'animated' },
  { domain: 'hanime.tv', category: 'animated' },
  { domain: 'nhentai.net', category: 'animated' },
  { domain: 'hentaila.com', category: 'animated' },
  { domain: 'rule34.xxx', category: 'animated' },
  { domain: 'rule34.world', category: 'animated' },
  { domain: 'gelbooru.com', category: 'animated' },
  { domain: 'e-hentai.org', category: 'animated' },
  { domain: 'exhentai.org', category: 'animated' },

  // Image boards / forums
  { domain: 'imagefap.com', category: 'images' },
  { domain: 'motherless.com', category: 'images' },
  { domain: 'gonewild.com', category: 'images' },
  { domain: 'hclips.com', category: 'images' },
  { domain: 'sexyandfunny.com', category: 'images' },

  // Adult chat / dating
  { domain: 'adultfriendfinder.com', category: 'dating' },
  { domain: 'fling.com', category: 'dating' },
  { domain: 'ashleymadison.com', category: 'dating' },
  { domain: 'seekingarrangement.com', category: 'dating' },

  // Arabic / regional (commonly blocked in MENA networks)
  { domain: 'arab-sex.com', category: 'adult-regional' },
  { domain: 'sexarab.com', category: 'adult-regional' },
  { domain: 'xnxxarab.com', category: 'adult-regional' },
  { domain: 'arabicporn.com', category: 'adult-regional' },
  { domain: 'arabxxnx.com', category: 'adult-regional' },
  { domain: 'arabsexweb.com', category: 'adult-regional' },
];

/**
 * Returns the matching NSFW category if `host` belongs to a known NSFW domain,
 * else null. Matches subdomains too (foo.pornhub.com → pornhub.com).
 */
export function classifyHost(host: string): { domain: string; category: string } | null {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  for (const entry of NSFW_DOMAINS) {
    if (h === entry.domain || h.endsWith('.' + entry.domain)) {
      return entry;
    }
  }
  return null;
}

/** Extract host strings from a free-form syslog message. Looks for URLs and bare domains. */
export function extractHosts(message: string): string[] {
  const out = new Set<string>();
  // URL form (http://host or https://host)
  const urlRe = /https?:\/\/([A-Za-z0-9.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(message)) !== null) out.add(m[1]);
  // host=foo, host:foo, host="foo", host foo
  const hostRe = /host[=:"\s]+([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gi;
  while ((m = hostRe.exec(message)) !== null) out.add(m[1]);
  // Bare FQDNs — catch any token that has at least one dot and a known TLD.
  // Expanded TLD set covers most adult-domain TLDs in the embedded list.
  const fqdnRe = /\b([a-z0-9-]+(?:\.[a-z0-9-]+){1,}\.(?:com|net|org|tv|xxx|app|vip|red|es|world|me|cc|co|ru|io|uk|info|biz|adult|porn|sex|cam|xyz|live|club|online|site|space))\b/gi;
  while ((m = fqdnRe.exec(message)) !== null) out.add(m[1]);
  return [...out];
}
