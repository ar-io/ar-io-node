import { createHash } from 'crypto';

export function fromB64Url(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

export function toB64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function sha256B64Url(input: Buffer): string {
  return toB64url(createHash('sha256').update(input).digest());
}
