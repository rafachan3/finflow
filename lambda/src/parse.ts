export type QuickLog = {
  amount: string;
  description: string;
  currency: "CAD";
};

const RE = /^\s*(\d+)(?:[.,](\d{1,2}))?\s+(.+?)\s*$/;

export function parseQuickLog(text: string): QuickLog | null {
  const m = text.match(RE);
  if (!m) return null;
  const whole = m[1];
  const frac = (m[2] ?? "00").padEnd(2, "0").slice(0, 2);
  const description = m[3].trim();
  if (!description) return null;
  return { amount: `${whole}.${frac}`, description, currency: "CAD" };
}
