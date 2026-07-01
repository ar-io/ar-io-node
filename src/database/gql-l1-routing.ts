/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { utf8ToB64Url } from '../lib/encoding.js';
import { ItemFilter, MatchableTxLike } from '../types.js';

// The subset of the composable filter DSL whose `match()` semantics are
// MONOTONE: adding tags/attributes to an item can only flip a predicate from
// false→true, never true→false. Monotonicity is what makes *query entailment*
// sound (see isL1OnlyQuery): a monotone filter that matches the minimal item a
// query guarantees also matches every (larger) real result of that query.
const MONOTONE_FILTER_KEYS = [
  'tags',
  'attributes',
  'and',
  'or',
  'always',
  'never',
];

// Constructs that break entailment. `not` inverts match polarity, so a filter
// it satisfies on the minimal synthetic item can be violated by a real result
// carrying extra tags the query never forbade. `isNestedBundle` / `hashPartition`
// key on item identity/shape a GQL query does not pin. Any of these makes the
// L1-only routing decision unsound, so they are rejected at config load.
const REJECTED_FILTER_KEYS = ['not', 'isNestedBundle', 'hashPartition'];

// Upper bound on the cartesian product of synthetic items evaluated per query.
// Above this, decline to route (conservative) rather than spend the CPU.
const MAX_SYNTHETIC_ITEMS = 256;

/**
 * Throws if `filterJson` uses any construct outside the monotone subset the
 * L1 router can reason about soundly. Call at config-load time so operator
 * misconfiguration fails fast rather than silently mis-routing queries.
 */
export function assertMonotoneFilter(filterJson: any): void {
  // `undefined` / `''` / `{never:...}` all parse to NeverMatch — trivially sound.
  if (filterJson === undefined || filterJson === null || filterJson === '') {
    return;
  }
  if (typeof filterJson !== 'object') {
    throw new Error(
      `Invalid GQL L1 routing filter: ${JSON.stringify(filterJson)}`,
    );
  }
  for (const key of REJECTED_FILTER_KEYS) {
    if (key in filterJson) {
      throw new Error(
        `GQL L1 routing filter does not support "${key}" — only ` +
          `${MONOTONE_FILTER_KEYS.join(', ')} are allowed, because entailment ` +
          `over non-monotone predicates would drop valid data-item results.`,
      );
    }
  }
  for (const child of filterJson.and ?? []) assertMonotoneFilter(child);
  for (const child of filterJson.or ?? []) assertMonotoneFilter(child);
}

// Full cartesian product of the given lists. `cartesian([])` is `[[]]` (one
// empty combination), so a query with no tag constraints still yields a single
// synthetic item carrying just its owner/recipient attributes.
function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>(
    (acc, list) => acc.flatMap((combo) => list.map((item) => [...combo, item])),
    [[]],
  );
}

/**
 * Builds the set of *minimal* synthetic items a query guarantees its results
 * carry. A GQL `transactions` query ANDs its constraints, and within a tag the
 * `values` list is an OR and `owners`/`recipients` are ORs — so a result may
 * carry any one value per tag and any one owner/recipient. We enumerate the
 * cartesian product of those choices; every real result equals one of these
 * minimal items plus possibly extra tags.
 */
function buildSyntheticItems({
  owners,
  recipients,
  tags,
}: {
  owners: string[];
  recipients: string[];
  tags: { name: string; values: string[] }[];
}): MatchableTxLike[] {
  // One choice list per tag: the tag name paired with each candidate value.
  // A name-only constraint (empty values) contributes a single tag with an
  // empty value, which a name-only filter tag matches but a value-specific
  // filter tag does not (conservative).
  const tagChoiceLists = tags.map((tag) => {
    const values = tag.values.length > 0 ? tag.values : [''];
    return values.map((value) => ({
      name: utf8ToB64Url(tag.name),
      value: utf8ToB64Url(value),
    }));
  });

  const ownerChoices = owners.length > 0 ? owners : [undefined];
  const recipientChoices = recipients.length > 0 ? recipients : [undefined];

  const items: MatchableTxLike[] = [];
  for (const tagCombo of cartesian(tagChoiceLists)) {
    for (const owner of ownerChoices) {
      for (const target of recipientChoices) {
        const item: MatchableTxLike = { tags: tagCombo };
        if (owner !== undefined) item.owner_address = owner;
        if (target !== undefined) item.target = target;
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * Decides whether a GQL `transactions` query is provably confined to L1
 * (non-bundled) results by the operator-configured routing `filter`, and may
 * therefore be served from the L1-only SQLite index instead of ClickHouse.
 *
 * Sound by construction: every real result carries at least the query's
 * ANDed constraints, so if the (monotone) filter matches *every* minimal
 * synthetic item the query permits, it matches every real result. The routing
 * filter is an operator assertion that queries it entails are L1-only — the
 * tag alone does not prove L1-ness (e.g. SmartWeaveAction also exists as
 * bundled data items), so bundled matches are intentionally excluded.
 *
 * Conservative on every uncertain edge — a false negative only forgoes an
 * optimization, whereas a false positive would silently drop data-item results.
 */
export function isL1OnlyQuery({
  filter,
  ids = [],
  owners = [],
  recipients = [],
  tags = [],
}: {
  filter: ItemFilter;
  ids?: string[];
  owners?: string[];
  recipients?: string[];
  tags?: { name: string; values: string[] }[];
}): boolean {
  // Id lookups have their own selective path and pin results to specific items
  // whose tags we cannot enumerate here — never reroute them.
  if (ids.length > 0) return false;

  // Bound the combinatorial blow-up before materializing anything.
  let combinations =
    Math.max(1, owners.length) * Math.max(1, recipients.length);
  for (const tag of tags) {
    combinations *= Math.max(1, tag.values.length);
  }
  if (combinations > MAX_SYNTHETIC_ITEMS) return false;

  const items = buildSyntheticItems({ owners, recipients, tags });
  if (items.length === 0) return false;
  return items.every((item) => filter.match(item));
}
