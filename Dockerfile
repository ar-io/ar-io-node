FROM node:17 as build

RUN apt-get update -y && apt-get install sqlite3 -y

WORKDIR /app
COPY . .
RUN yarn install
RUN yarn build

RUN sqlite3 data/sqlite/standalone.db < schema.sql

CMD [ "yarn", "start" ]