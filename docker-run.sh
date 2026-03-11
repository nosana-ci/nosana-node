#!/bin/bash

# Build the Docker image
docker build -t nosana_node:latest -f Dockerfile .

# Create the network if it doesn't exist
docker network create --driver bridge --subnet 192.168.101.0/24 --gateway 192.168.101.1 NOSANA_GATEWAY 2>/dev/null || true

# Run the container with file watching
docker run -it --rm \
  --name nosana-node \
  --network NOSANA_GATEWAY \
  --env APP_ENV=development \
  -v ~/.nosana/:/root/.nosana/ \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)"/src:/nosana/src \
  -v "$(pwd)"/package.json:/nosana/package.json \
  -v "$(pwd)"/tsconfig.json:/nosana/tsconfig.json \
  nosana_node:latest \
  $@

