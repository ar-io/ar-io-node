import { createLogger, transports, format } from 'winston';

const logger = createLogger({
  level: 'info',
  transports: new transports.Console({
    format: format.simple(),
  }),
});

export default logger;
