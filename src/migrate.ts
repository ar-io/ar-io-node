import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { JSONStorage, Umzug } from 'umzug';

const umzug = new Umzug({
  migrations: {
    glob: 'migrations/*.{ts,up.sql}',
    resolve: (params) => {
      const path = params.path as string;
      if (!path?.endsWith('.sql')) {
        return Umzug.defaultResolver(params);
      }
      return {
        name: params.name,
        up: async () => {
          // TODO throw if dbname is missing from file name
          // TODO extract repeated logic
          const sql = fs.readFileSync(path).toString();
          const dbname = path.split('/').pop()?.split('.')[1];
          const db = new Sqlite(`./data/sqlite/${dbname}.db`);
          try {
            return db.exec(sql);
          } finally {
            db.close();
          }
        },
        down: async () => {
          const sql = fs
            .readFileSync(path.replace('.up.sql', '.down.sql'))
            .toString();
          const dbname = path.split('/').pop()?.split('.')[1];
          const db = new Sqlite(`./data/sqlite/${dbname}.db`);
          try {
            return db.exec(sql);
          } finally {
            db.close();
          }
        },
      };
    },
    // TODO add create template
  },
  // TODO use SQLite storage
  storage: new JSONStorage({ path: './migrations/umzug.json' }),
  logger: console,
});

// TODO is this actually necessary?
// export the type helper exposed by umzug, which will have the `context`
// argument typed correctly
export type Migration = typeof umzug._types.migration;

umzug.runAsCLI();
