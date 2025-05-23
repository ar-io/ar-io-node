/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// Dimensions of routing (initial dump):
// - Sandboxing
// - Subdomains (x.y.tld as ARNS_ROOT_HOST)
// - ArNS
//   - Non-undername
//     - Valid/invalid
//       - Lengths
//     - Non-manifest/manifest
//   - Undername
//     - Valid/invalid
//       - Lengths
//     - Non-manifest/manifest
// - Apex domains
//   - TX ID
//   - Names
//     - Non-undername/undername
// - Manifests
//   - Manifest versions - 0.1, 0.2
//   - Fallback/no-fallback
//   - Index/no-index
//   - Path hit/path miss
//   - Non-ArNS/ArNS
//   - Non-apex/apex
//   - Non-builtin-route/builtin-route

// Routing tree:
// - Other (Arweave, CUs, bundler) vs core service (via proxy)
//   - Manifest routes
//     - Has "protected" routes
//       - Apex
//       - ArNS (includes sandboxing)
//         - Custom 404s
//     - Data (not raw)
//   - Internal routes (other core service routes)

// Cross-cutting concerns:
// - Protected routes (/graphql, etc.)

// More stuff:
// - CUs
// - Bundler
// - Custom 404 - basename (current) and ANTs (future)

// Next steps:
// - DAG datastructure to represent intended routes
// - End-to-end test that uses DAG

// Implementation notes:
// - In general - use "live" but immutable data (or perma-buy)
// - Use snapshot of a subset of ArNS at point in time
