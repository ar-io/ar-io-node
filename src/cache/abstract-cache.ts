import winston from 'winston';

export abstract class FSCache {
  public log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: this.constructor.name });
  }
}
