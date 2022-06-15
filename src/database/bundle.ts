import winston from 'winston';
import { DataItem, IBundleDatabase } from '../types.js';
import logger from '../log.js';

export class BundleDatabase implements IBundleDatabase {
  private log: winston.Logger;

  constructor() {
    this.log = logger;
  }

  async saveDataItems(dataItems: DataItem[]): Promise<void> {
    this.log.info(`Saving ${dataItems.length} data items to bundle database`);
    return await new Promise((resolve) => resolve());
  }
}
