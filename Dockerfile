FROM node:16-alpine as builder

# BUILD
WORKDIR /app
RUN apk --no-cache add git 
COPY . .
RUN yarn install
RUN yarn build

# EXTRACT DIST
FROM node:16-alpine
WORKDIR /app
RUN apk add --no-cache sqlite curl

COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json /app/schema.sql /app/reset-db.sh /app/setup-db.sh ./
COPY --from=builder /app/dist/ ./dist/

# CREATE VOLUME
VOLUME /app/data

# SETUP DB - TODO: this will be replaced with migration library
RUN sh setup-db.sh

# EXPOSE PORT AND SETUP HEALTHCHECK
EXPOSE 3000
HEALTHCHECK CMD curl --fail http://localhost:3000 || exit 1   

# START
CMD [ "node", "dist/app.js" ]
