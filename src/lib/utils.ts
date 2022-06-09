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

export const txTagsToRows = (tx_id, tags) => {
  return (
    tags
      .map((tag, index) => {
        const { name, value } = utf8DecodeTag(tag);
        return {
          tx_id,
          index,
          name,
          value
        };
      })
      // The name and values columns are indexed, so ignore any values that are too large.
      // Postgres will throw an error otherwise: index row size 5088 exceeds maximum 2712 for index "tags_name_value"
      .filter(
        ({ name, value }) => (name.length || 0) + (value.length || 0) < 2712
      )
  );
};
