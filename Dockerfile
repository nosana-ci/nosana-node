FROM node:20.11.1 AS base

WORKDIR /nosana

COPY package.json .
COPY npm-shrinkwrap.json .

RUN npm ci

FROM base AS production

COPY . .

ENTRYPOINT ["node", "--no-warnings", "--loader", "ts-node/esm", "src/index.ts"]