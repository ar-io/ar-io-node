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
import {
  BlockListValidator,
  BundleIndex,
  BundleRecord,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataParent,
  GqlQueryable,
  NestedDataIndexWriter,
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../../types';
import * as winston from 'winston';
import CircuitBreaker from 'opossum';
import * as config from '../../config.js';
import * as metrics from '../../metrics.js';
import { Worker } from 'node:worker_threads';
/* eslint-disable */
// @ts-ignore
import { default as yesql } from "yesql";
import {
  DebugInfo, GqlQueryInput, GqlQuerysaveData, IDInput,
  WORKER_POOL_NAMES, WORKER_ROLE_NAMES, WorkerMethodName,
  WorkerPoolName,
  WorkerPoolSizes,
  WorkerRoleName,
  WorkersType
} from "./PostgressDatabaseTypes.js";
import os from "node:os";

const CPU_COUNT = os.cpus().length;
const MAX_WORKER_COUNT = 12;

export const WORKER_POOL_SIZES: WorkerPoolSizes = {
  core: { read: 1, write: 1 },
  data: { read: 2, write: 1 },
  gql: { read: Math.min(CPU_COUNT, MAX_WORKER_COUNT), write: 0 },
  debug: { read: 1, write: 0 },
  moderation: { read: 1, write: 1 },
  bundles: { read: 1, write: 1 }
};

export class StandalonePostgresDatabase
  implements BundleIndex,
    BlockListValidator,
    ChainIndex,
    ChainOffsetIndex,
    ContiguousDataIndex,
    GqlQueryable,
    NestedDataIndexWriter {
  log: winston.Logger;

  private workers: WorkersType = {
    core: { read: [], write: [] },
    data: { read: [], write: [] },
    gql: { read: [], write: [] },
    debug: { read: [], write: [] },
    moderation: { read: [], write: [] },
    bundles: { read: [], write: [] }
  };
  private workQueues: WorkersType = {
    core: { read: [], write: [] },
    data: { read: [], write: [] },
    gql: { read: [], write: [] },
    debug: { read: [], write: [] },
    moderation: { read: [], write: [] },
    bundles: { read: [], write: [] }
  };

  // Data index circuit breakers
  private readonly getDataParentCircuitBreaker: CircuitBreaker<Parameters<StandalonePostgresDatabase["getDataParent"]>, Awaited<ReturnType<StandalonePostgresDatabase["getDataParent"]>>>;
  private readonly getDataAttributesCircuitBreaker: CircuitBreaker<Parameters<StandalonePostgresDatabase["getDataAttributes"]>, Awaited<ReturnType<StandalonePostgresDatabase["getDataAttributes"]>>>;

  constructor({log}: { log: winston.Logger; }) {
    this.log = log.child({ class: `${this.constructor.name}` });

    //
    // Initialize data index circuit breakers
    //

    const dataIndexCircuitBreakerOptions = {
      timeout: config.GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage: 50,
      rollingCountTimeout: 5000,
      resetTimeout: 10000
    };

    this.getDataParentCircuitBreaker = new CircuitBreaker(
      (id: string) => {
        return this.queueRead("data", `getDataParent`, [id]);
      },
      {
        name: "getDataParent",
        ...dataIndexCircuitBreakerOptions
      }
    );

    this.getDataAttributesCircuitBreaker = new CircuitBreaker(
      (id: string) => this.queueRead("data", `getDataAttributes`, [id]),
      {
        name: "getDataAttributes", ...dataIndexCircuitBreakerOptions
      }
    );

    metrics.circuitBreakerMetrics.add([this.getDataParentCircuitBreaker, this.getDataAttributesCircuitBreaker]);

    //
    // Initialize workers
    //

    const self = this;

    function spawn(pool: WorkerPoolName, role: WorkerRoleName) {
      const workerUrl = new URL("./../standalone-postgres.js", import.meta.url);
      const worker = new Worker(workerUrl);

      let job: any = null; // Current item from the queue
      let error: any = null; // Error that caused the worker to crash

      function takeWork() {
        if (!job && self.workQueues[pool][role].length) {
          // If there's a job in the queue, send it to the worker
          job = self.workQueues[pool][role].shift();
          worker.postMessage(job.message);
        }
      }

      worker
        .on("online", () => {
          self.workers[pool][role].push({ takeWork });
          takeWork();
        })
        .on("message", (result) => {
          if (result === "__ERROR__") {
            job.reject(new Error("Worker error"));
          } else {
            job.resolve(result);
          }
          job = null;
          takeWork(); // Check if there's more work to do
        })
        .on("error", (err) => {
          self.log.error("Worker error", err);
          error = err;
        })
        .on("exit", (code) => {
          self.workers[pool][role] = self.workers[pool][role].filter(
            (w) => w.takeWork !== takeWork
          );
          if (job) {
            job.reject(error || new Error("worker died"));
          }
          if (code !== 0) {
            self.log.error("Worker stopped with exit code " + code, {
              exitCode: code
            });
            spawn(pool, role); // Worker died, so spawn a new one
          }
        });
    }

    WORKER_POOL_NAMES.forEach((pool) => {
      // Spawn readers
      for (let i = 0; i < WORKER_POOL_SIZES[pool].read; i++) {
        spawn(pool, "read");
      }

      // Spawn writers
      for (let i = 0; i < WORKER_POOL_SIZES[pool].write; i++) {
        spawn(pool, "write");
      }
    });
  }

  async stop() {
    const log = this.log.child({ method: "stop" });
    const promises: Promise<void>[] = [];
    WORKER_POOL_NAMES.forEach((pool) => {
      WORKER_ROLE_NAMES.forEach((role) => {
        this.workers[pool][role].forEach(() => {
          promises.push(
            new Promise((resolve, reject) => {
              this.workQueues[pool][role].push({
                resolve,
                reject,
                message: {
                  method: "terminate"
                }
              });
              this.drainQueue();
            })
          );
        });
      });
    });

    await Promise.all(promises);
    log.debug("Stopped successfully.");
  }

  drainQueue() {
    WORKER_POOL_NAMES.forEach((pool) => {
      WORKER_ROLE_NAMES.forEach((role) => {
        for (const worker of this.workers[pool][role]) {
          worker.takeWork();
        }
      });
    });
  }

  queueWork(
    workerName: WorkerPoolName,
    role: WorkerRoleName,
    method: WorkerMethodName,
    args: any
  ): Promise<any> {
    const end = metrics.methodDurationSummary.startTimer({
      worker: workerName,
      role,
      method
    });
    const ret = new Promise((resolve, reject) => {
      this.workQueues[workerName][role].push({
        resolve,
        reject,
        message: {
          method,
          args
        }
      });
      this.drainQueue();
    });
    ret.finally(() => end());
    return ret;
  }

  queueRead(
    pool: WorkerPoolName,
    method: WorkerMethodName,
    args: any
  ): Promise<any> {
    return this.queueWork(pool, "read", method, args);
  }

  queueWrite(
    pool: WorkerPoolName,
    method: WorkerMethodName,
    args: any
  ): Promise<any> {
    return this.queueWork(pool, "write", method, args);
  }

  getMaxHeight(): Promise<number> {
    return this.queueRead("core", "getMaxHeight", undefined);
  }
  getBlockHashByHeight(height: number): Promise<string | undefined> {
    return this.queueRead("core", "getBlockHashByHeight", [height]);
  }

  getMissingTxIds(limit: number): Promise<string[]> {
    return this.queueRead("core", "getMissingTxIds", [limit]);
  }

  getFailedBundleIds(limit: number): Promise<string[]> {
    return this.queueRead("bundles", "getFailedBundleIds", [limit]);
  }

  backfillBundles() {
    return this.queueRead("bundles", "backfillBundles", undefined);
  }

  updateBundlesFullyIndexedAt(): Promise<void> {
    return this.queueRead("bundles", "updateBundlesFullyIndexedAt", undefined);
  }

  updateBundlesForFilterChange(unbundleFilter: string, indexFilter: string) {
    return this.queueWrite("bundles", "updateBundlesForFilterChange", [
      unbundleFilter,
      indexFilter
    ]);
  }

  resetToHeight(height: number): Promise<void> {
    return this.queueWrite("core", "resetToHeight", [height]);
  }

  saveTx(tx: PartialJsonTransaction): Promise<void> {
    return this.queueWrite("core", "saveTx", [tx]);
  }

  getTxIdsMissingOffsets(limit: number): Promise<string[]> {
    return this.queueRead("core", "getTxIdsMissingOffsets", [limit]);
  }

  saveTxOffset(id: string, offset: number) {
    return this.queueWrite("core", "saveTxOffset", [id, offset]);
  }

  saveDataItem(item: NormalizedDataItem): Promise<void> {
    return this.queueWrite("bundles", "saveDataItem", [item]);
  }

  saveBundle(bundle: BundleRecord): Promise<void> {
    return this.queueWrite("bundles", "saveBundle", [bundle]);
  }

  saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[]
  ): Promise<void> {
    return this.queueWrite("core", "saveBlockAndTxs", [block, txs, missingTxIds]);
  }

  async getDataAttributes(id: string): Promise<ContiguousDataAttributes | undefined> {
    try {
      return await this.getDataAttributesCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  async getDataParent(id: string): Promise<ContiguousDataParent | undefined> {
    try {
      return await this.getDataParentCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  getDebugInfo(): Promise<DebugInfo> {
    return this.queueRead("debug", "getDebugInfo", undefined);
  }

  saveDataContentAttributes({ id, dataRoot, hash, dataSize, contentType }: GqlQuerysaveData) {
    return this.queueWrite("data", "saveDataContentAttributes", [{ id, dataRoot, hash, dataSize, contentType }]);
  }


  async getGqlSearchByTags({ tags = [] }: {
    tags?: {
      name: string;
      values: string[]
    }[]
  }) {
    return this.queueRead("gql", "getGqlSearchByTags", [{ tags }]);
  }

  getGqlTransactions({
                       pageSize,
                       cursor,
                       sortOrder = "HEIGHT_DESC",
                       ids = [],
                       recipients = [],
                       owners = [],
                       minHeight = -1,
                       maxHeight = -1,
                       bundledIn,
                       tags = []
                     }: GqlQueryInput) {
    return this.queueRead("gql", "getGqlTransactions", [{
      pageSize,
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags
    }]);
  }

  async getGqlTransaction({ id }: IDInput) {
    return this.queueRead("gql", "getGqlTransaction", [{ id }]);
  }

  getGqlBlocks({ pageSize, cursor, sortOrder = "HEIGHT_DESC", ids = [], minHeight = -1, maxHeight = -1 }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: "HEIGHT_DESC" | "HEIGHT_ASC";
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    return this.queueRead("gql", "getGqlBlocks", [{ pageSize, cursor, sortOrder, ids, minHeight, maxHeight }]);
  }

  getGqlBlock({ id }: IDInput) {
    return this.queueRead("gql", "getGqlBlock", [{ id }]);
  }

  async isIdBlocked(id: string | undefined): Promise<boolean> {
    return this.queueRead("moderation", "isIdBlocked", [id]);
  }

  async isHashBlocked(hash: string | undefined): Promise<boolean> {
    return this.queueRead("moderation", "isHashBlocked", [hash]);
  }

  async blockData({ id, hash, source, notes }: {
    id?: string;
    hash?: string;
    source?: string;
    notes?: string;
  }): Promise<void> {
    return this.queueWrite("moderation", "blockData", [{ id, hash, source, notes }]);
  }

  async saveNestedDataId({ id, parentId, dataOffset, dataSize }: {
    id: string;
    parentId: string;
    dataOffset: number;
    dataSize: number;
  }): Promise<void> {
    return this.queueWrite("data", "saveNestedDataId", [{ id, parentId, dataOffset, dataSize }]);
  }

  async saveNestedDataHash({ hash, parentId, dataOffset }: {
    hash: string;
    parentId: string;
    dataOffset: number;
  }): Promise<void> {
    return this.queueWrite("data", "saveNestedDataHash", [{ hash, parentId, dataOffset }]);
  }
}
