const BBC_HOSTS = new Set(["bbc.co.uk", "www.bbc.co.uk", "bbc.com", "www.bbc.com"]);

export function isBbcArticleUrl(url: URL): boolean {
  return url.protocol === "https:" && BBC_HOSTS.has(url.hostname) && url.pathname.startsWith("/sport/");
}

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "fbclid" || key === "gclid" ||
        (isBbcArticleUrl(url) && (key === "at_medium" || key === "at_campaign"))) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

export function bbcArticleBase(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  return isBbcArticleUrl(url) ? `${url.origin}${url.pathname}` : null;
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
