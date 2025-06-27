# How to Run a Community Gateway (Draft)

> **Note**: This document is an initial draft intended to outline the key
> concepts and tasks involved in operating a community gateway. It is not a
> step-by-step walkthrough. Future revisions will expand on these concepts and
> provide more detailed procedures.

## Understanding Your Data

Before running a gateway, take time to understand the data you are working
with and how it will appear once on the network.

- Become familiar with the structure and size of the data you plan to serve.
- Know how your data will be bundled and placed on-chain.
- Learn where to locate your data after it is written to the network.

## Data Flow & Location

Community gateways are responsible for bundling data, sending it to the Arweave
network, and making it retrievable.

1. **Bundling and Uploading**
   - Identify the part of your workflow that creates bundles and submits them
     to the chain.
   - Understand what a bundle contains and how it relates to the data you wish
     to expose.
2. **Finding Data On-Chain**
   - Track the transaction IDs for your bundles so you can locate them later.
   - Use available indexing tools or gateways to confirm your data has been
     stored and is accessible.

## Optimizing Data for the Network

Poorly structured or inconsistent data can make indexing and retrieval harder.
Consider adjusting your data submission process to improve overall visibility.

- Ensure your bundles are valid and conform to any current gateway standards.
- Keep the format of your items consistent so they can be easily discovered.
- If possible, test how your data is indexed and adjust your pipeline to
  minimize issues.

## System & Technical Requirements

Running a gateway involves unbundling data, indexing it, and providing it to
users. The resources needed depend on how much data you plan to process.

- Estimate the storage, CPU, and memory requirements for your workload.
- Decide whether you will index historical data or only new data as it arrives.
- Understand how optimistic indexing works and know its limitations—sometimes
  manual intervention or a full re-index may be necessary.

## Monitoring & Troubleshooting

A gateway operator should continuously watch the system and be ready to respond
when something goes wrong.

- Monitor logs and metrics to confirm that data is uploading and indexing as
  expected.
- Track progress so you know if your gateway is falling behind.
- Learn the typical signs of failure—such as repeated indexing errors or stalled
  uploads—and be prepared to investigate.

## Moving Forward

This outline is intentionally broad to cover the areas a gateway operator must
understand. As you gain experience, refine these notes with specific commands
and examples. The goal is to iteratively produce a clear, complete guide that
any new operator can follow.
