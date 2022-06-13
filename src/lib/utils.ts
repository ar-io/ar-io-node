import { createHash } from 'crypto';

export function fromB64Url(input: string) {
  return Buffer.from(input, 'base64');
}

export function toB64url(buffer: Buffer) {
  return buffer.toString('base64');
}

export function sha256B64Url(input: Buffer) {
  return toB64url(createHash('sha256').update(input).digest());
}
