import { createHash } from 'crypto';

// Base64 encoding and decoding

export function fromB64Url(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

export function toB64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function b64UrlToUtf8(input: string): string {
  return fromB64Url(input).toString('utf8');
}

export function utf8ToB64Url(input: string): string {
  return toB64Url(Buffer.from(input, 'utf8'));
}

export function sha256B64Url(input: Buffer): string {
  return toB64Url(createHash('sha256').update(input).digest());
}
