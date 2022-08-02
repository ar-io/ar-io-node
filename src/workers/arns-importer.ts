import * as EventEmitter from 'events';
import * as winston from 'winston';
import { JsonTransaction } from '../types';

const ARNS_ROOT_CONTRACT =
  process.env.ARNS_ROOT_CONTRACT ??
  'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U';

export class ArNSImporter {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;

  constructor({
    log,
    eventEmitter
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
  }) {
    this.log = log.child({ module: 'arns-importer' });
    this.eventEmitter = eventEmitter;

    this.eventEmitter.on('block-tx', (tx) => this.auditBlockTx(tx));
    this.log.info('ArNS enabled...listening for ArNS transactions');
  }

  private auditBlockTx(tx: JsonTransaction) {
    // TODO: store these in table or fetch from arweave
    const whitelistedArNSContracts: Set<string> = new Set([
      '7hL0La2KMapdJI6yIGnb4f4IjvhlGQyXnqpWc0i0d_w',
      'cNr6JPVu3rEOwIbdnu3lVipz9pwY5Pps9mxHSW7Jdtk',
      'JIIB01pRbNK2-UyNxwQK-6eknrjENMTpTvQmB8ZDzQg',
      'PEI1efYrsX08HUwvc6y-h6TSpsNlo2r6_fWL2_GdwhY'
    ]);
    const { tags } = tx;
    if (tags.length) {
      const isArnsContractRelated = tags.find((t) => {
        const { name: b64Name, value: b64Value } = t;
        const [name, value] = [b64Name, b64Value].map((d) =>
          Buffer.from(d, 'base64').toString()
        );
        // tx related to ArNS root contract change, update `arns_ant_contract` table if ANT confirmed valid
        if (name == 'Contract' && value === ARNS_ROOT_CONTRACT) {
          return true;
        }
        // TODO: lookup tx "Contract" tag in arns_ant_contract table if exists/is valid, return true
        // This will capture all tx's related to ArNS ANT contract change (new undername, pointer, etc.)
        if (
          name == 'Contract' &&
          value === 'gh673M0Koh941OIITVXl9hKabRaYWABQUedZxW-swIA'
        ) {
          return true;
        }
        // TODO: replace this with above logic, assuming tx is performed on pre-validated ANT contract
        if (name == 'Contract-Src' && whitelistedArNSContracts.has(value)) {
          return true;
        }
        return false;
      });

      if (isArnsContractRelated) {
        this.log.info('tx is ArNS related...updating arns_transactions table', {
          tx: tx.id
        });
        return;
      }
    }
  }
}
