import { createHmac, timingSafeEqual } from 'crypto';

export function signToken(leadId: string, secret: string): string {
  return createHmac('sha256', secret).update(leadId).digest('hex').slice(0, 32);
}

export function verifyToken(leadId: string, token: string, secret: string): boolean {
  const expected = signToken(leadId, secret);
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
