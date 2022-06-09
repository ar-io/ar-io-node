import { createHash } from 'crypto';

export function fromB64Url(input: string) {
  const paddingLength = input.length % 4 == 0 ? 0 : 4 - (input.length % 4);

  const base64 = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .concat('='.repeat(paddingLength));

  return Buffer.from(base64, 'base64');
}

export function toB64url(buffer: Buffer) {
  return buffer
    .toString('base64')
    .replace(/+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function sha256B64Url(input: Buffer) {
  return toB64url(createHash('sha256').update(input).digest());
}
