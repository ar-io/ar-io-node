# qBittorrent as the Index Swarm's Torrent Engine

- Status: accepted (implemented in the index-swarm BitTorrent tier)
- Deciders: [Phil]
- Date: 2026-09-23
- Authors: [Phil]

## Context and Problem Statement

The index-swarm sidecar moves signed index bands between gateways over
BitTorrent as well as HTTP. It builds its own deterministic hybrid v1 + v2
torrents and drives an engine in a separate container, which must seed from
read-only mounts, verify both halves of a hybrid torrent, take WebSeeds
added and removed at runtime, and keep a band's files directly in a
directory not named after the torrent. Which engine?

## Decision

The engine is **qBittorrent-nox 5.2.3 on libtorrent 2.0.13**
(`qbittorrentofficial/qbittorrent-nox:5.2.3-lt2-1`), driven through its
**Web API 2.15.1**. It was chosen over Transmission and rqbit by running all
three through the same test on 2026-09-23: seed a 256-file band from a
read-only mount, then fetch it on a second instance from the WebSeed alone,
from a peer alone, and from both, using the deterministic hybrid v1 + v2
torrents the sidecar builds.

| | qBittorrent 5.2.3 | Transmission 4.1.3 | rqbit 9.0.1 |
|---|---|---|---|
| Hybrid v1 + v2 | Yes, verifies both | v1 half only; pad files treated as real files | v1 half only |
| Seeds from a read-only mount | Yes, writes nothing | v1 torrents only | **No**: opens files read-write, add fails |
| Verifies on add, 20 GiB, cold, SSD | 59 s | Not at all (trusts sizes); forced verify 50 s | n/a |
| WebSeed only, 2.2 GB | 9.5 s | 20 s | **No WebSeed support** |
| Peer only, 2.2 GB | 64 s | 49 s | not run |
| Both, 21.6 GB | 181 s, 48% from the WebSeed | 276 s, 54% from the WebSeed | |
| WebSeeds changed at runtime | Yes (`addWebSeeds`, `removeWebSeeds`) | No, read only | |
| Files in a directory not named after the torrent | `contentLayout=NoSubfolder` | `torrent-rename-path` | `output_folder` |
| Memory, seeding 22 GiB, idle | 98 MiB anonymous, plus up to 833 MiB of mapped file pages | 2 MiB anonymous, 6 MiB resident | |
| Time from add to first WebSeed request | 0.5 to 1.2 s | 2.9 to 3.8 s | |
| API | REST, cookie login or subnet allowlist | JSON-RPC with a session-id header | REST, no auth |
| Image | 182 MB | 84 MB | 29 MB, and must run as root |

**Why not Transmission.** It reads only the v1 half of a hybrid torrent and
treats its BEP 47 pad files as real files, so a hybrid band never completes:
it requests `.pad/<n>` from the WebSeed and tries to rename the finished
files to `.part` on the read-only mount. Using it would mean giving up v2 and
cross-publisher deduplication, and it cannot change a torrent's WebSeeds
while running.

**Why not rqbit.** It cannot seed from a read-only mount, and the engine must
never be able to modify what the gateway serves. It also has no WebSeed
support, which removes the fallback the design depends on.

Two findings from that test shaped the rest of the design. Engines treat a
WebSeed as one more peer, which is why torrents carry no WebSeed (see
[index-swarm.md](../index-swarm.md#publishing-torrents)). And every file, the
last included, is padded to a piece boundary, which is what libtorrent
itself does: a band built by the sidecar and one built by libtorrent from
the same files share both infohashes and join one swarm.
