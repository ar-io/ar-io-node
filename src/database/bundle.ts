import winston from 'winston';
import { DataItem, IBundleDatabase } from '../types.js';
import logger from '../log.js';

/* eslint-disable */
export class BundleDatabase implements IBundleDatabase {

  private log: winston.Logger;
  constructor(){
    this.log = logger;
  }
  // @ts-ignore
  async saveDataItems(dataItems: DataItem[]): Promise<void> {
    this.log.info(`Saving ${dataItems.length} data itmes to bundle database`);
    // TODO: implement this class
    return await new Promise(resolve => resolve());
  }
}
