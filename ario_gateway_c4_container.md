```mermaid
C4Container
  title Container diagram for AR.IO Gateway

  Person(end_user, "End User", "A person using the AR.IO Gateway to interact with the Arweave ecosystem.")
  System_Ext(arweave_blockweave, "Arweave Blockweave", "The decentralized, permanent storage network.")
  System_Ext(ario_network, "AR.IO Network", "The network of AR.IO Gateways and related services (e.g., ArNS, Observation Network).")

  System_Boundary(c1, "AR.IO Gateway") {
    Container(envoy_service, "Envoy Service", "Proxy", "Handles incoming requests and routes them.")
    Container(core_service, "Core Service", "Main Application Logic", "Handles core gateway functionality, data retrieval, and interactions with Arweave and AR.IO Network.")
    Container(observer_service, "Observer Service", "Monitors AR.IO Network", "Observes the AR.IO Network and reports findings.")
    Container(bundler_service, "Bundler Service", "Sidecar for bundling data", "Responsible for creating and submitting data bundles to Arweave.")
    Container(ao_cu, "AO Compute Unit (CU)", "Sidecar for AO processes", "Executes Arweave Object (AO) processes.")
    
    ContainerDb(index_db, "Index Database", "Stores chain/bundle indexes", "Stores metadata and indexes for efficient data lookup.")
    ContainerDb(chunk_storage, "Chunk Storage", "Stores data chunks", "Stores actual data chunks retrieved from Arweave.")
    ContainerDb(header_storage, "Header Storage", "Stores block/transaction headers", "Stores block and transaction header information.")
  }

  Rel(end_user, envoy_service, "Makes requests")
  
  Rel(envoy_service, core_service, "Routes requests to")
  Rel(envoy_service, ao_cu, "Routes AO requests to")
  Rel(envoy_service, arweave_blockweave, "Proxies some requests to", "e.g., specific chain data")

  Rel(core_service, index_db, "Uses for index lookups")
  Rel(core_service, chunk_storage, "Uses for data chunk storage/retrieval")
  Rel(core_service, header_storage, "Uses for header storage/retrieval")
  
  Rel(core_service, arweave_blockweave, "Interacts with")
  Rel(core_service, ario_network, "Interacts with")
  Rel(core_service, bundler_service, "Delegates bundling to")
  Rel(core_service, ao_cu, "Interacts with for AO operations")

  Rel(observer_service, ario_network, "Monitors")
  # Assuming Observer Service might have its own local DB for reports, not explicitly requested but common.
  # ContainerDb(observer_db, "Observer Local DB", "Stores observation reports")
  # Rel(observer_service, observer_db, "Stores reports in")

  Rel(bundler_service, core_service, "Receives data from")
  Rel(bundler_service, arweave_blockweave, "Submits bundles to")
  
  Rel(ao_cu, core_service, "Receives tasks from / sends results to")
  Rel(ao_cu, bundler_service, "May interact with for bundling AO results")
  Rel(ao_cu, arweave_blockweave, "Interacts with", "e.g., for state checkpoints, reading messages")

```
