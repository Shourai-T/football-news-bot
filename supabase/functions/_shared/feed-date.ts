export type FeedDatePolicy = "standard" | "sky-uk";

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;
const RFC = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(GMT|UTC|[+-]\d{4})$/i;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

export function parsePublicationDate(value: string, policy: FeedDatePolicy): Date | null {
  const text = policy === "sky-uk" ? value.trim().replace(/\sBST$/i, " +0100") : value.trim();
  const iso = ISO.exec(text);
  const rfc = iso ? null : RFC.exec(text);
  if (!iso && !rfc) return null;

  const fields = iso
    ? iso.slice(1, 7).map(Number)
    : [Number(rfc![3]), MONTHS.indexOf(rfc![2]!.toLowerCase()) + 1,
      Number(rfc![1]), ...rfc!.slice(4, 7).map(Number)];
  const [year, month, day, hour, minute, second] = fields as [number, number, number, number, number, number];
  const millis = Number((iso?.[7] ?? "").padEnd(3, "0"));
  const offset = parseOffset(iso?.[8] ?? rfc![7]!);
  if (offset === null || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return new Date(date.getTime() - offset * 60_000);
}

function parseOffset(value: string): number | null {
  if (/^(?:Z|GMT|UTC)$/i.test(value)) return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
}
