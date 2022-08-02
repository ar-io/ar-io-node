import * as EventEmitter from 'events';
import * as winston from 'winston';
import { ArNSDatabase, JsonTransaction } from '../types';

const ARNS_ROOT_CONTRACT =
  process.env.ARNS_ROOT_CONTRACT ??
  'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U';

export class ArNSImporter {
  // Dependencies
  private arnsDB: ArNSDatabase;
  private log: winston.Logger;
  private eventEmitter: EventEmitter;

  constructor({
    arnsDB,
    log,
    eventEmitter
  }: {
    arnsDB: ArNSDatabase;
    log: winston.Logger;
    eventEmitter: EventEmitter;
  }) {
    this.arnsDB = arnsDB;
    this.log = log.child({ module: 'arns-importer' });
    this.eventEmitter = eventEmitter;
  }

  private async identifyAndSaveArNSTx(tx: JsonTransaction) {
    // TODO: maybe check this for every increment in block height (block events) or only when we know there has been
    // a change to root ArNS contract state.
    const whitelistedSourceContracts =
      (await this.arnsDB.getWhitelistedContracts()) as string[];
    const { tags } = tx;
    if (tags.length) {
      let isArNSTx = false;
      for await (const t of tags) {
        const { name: b64Name, value: b64Value } = t;
        const [name, value] = [b64Name, b64Value].map((d) =>
          Buffer.from(d, 'base64').toString()
        );
        // tx related to ArNS root contract change, update `arns_ant_contract` table if ANT confirmed valid
        if (name === 'Contract' && value === ARNS_ROOT_CONTRACT) {
          console.log('Identified root ArNS Contract change', {
            tx: tx.id,
            contract: ARNS_ROOT_CONTRACT
          });
          isArNSTx = true;
          break;
        }
        // TODO: lookup tx "Contract" tag in arns_ant_contract table if exists/is valid, return true
        // This will capture all tx's related to ArNS ANT contract change (new undername, pointer, etc.)
        if (name === 'Contract' && (await this.arnsDB.getANTContract(value))) {
          console.log('Identified an ANT contract state change', {
            tx: tx.id,
            contract: await this.arnsDB.getANTContract(value)
          });
          isArNSTx = true;
          break;
        }
        // A new ANT Contract is created, but might not be registered against ArNS Root contract
        // so log, but don't do anything for now
        if (
          name === 'Contract-Src' &&
          whitelistedSourceContracts.includes(value)
        ) {
          this.log.info('A new ArNS ANT contract was created...skipping');
          break;
        }
      }

      if (isArNSTx) {
        this.log.info('Identified ArNS tx...updating arns_transactions table', {
          tx: tx.id
        });
        return;
      }
    }
  }

  public start() {
    this.eventEmitter.on(
      'block-tx',
      async (tx) => await this.identifyAndSaveArNSTx(tx)
    );
    this.log.info('ArNS enabled...listening for ArNS transactions');
  }

  public stop() {
    this.eventEmitter.removeAllListeners();
    this.log.info('ArNS disabled!');
  }
}
