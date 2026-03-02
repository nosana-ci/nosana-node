FROM node:20.11.1 AS base

WORKDIR /nosana

COPY package.json .
COPY npm-shrinkwrap.json .

RUN npm ci --include=dev

FROM base AS production

COPY . .

ENTRYPOINT ["/bin/sh", "-c", "exec npx nodemon --legacy-watch --exec 'node --no-warnings --loader ts-node/esm src/index.ts' -- \"$@\"", "--"]