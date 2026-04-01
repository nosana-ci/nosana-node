#!/bin/bash

PODMAN_CONTAINER="podman"
PODMAN_IMAGE="nosana/podman:v1.1.0"
NOSANA_SRC="/nosana-src"
IMAGE_NAME="localhost/nosana_node:latest"

# Ensure the podman container has the project directory mounted
if ! docker inspect "$PODMAN_CONTAINER" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null | grep -q "$NOSANA_SRC"; then
  echo "Recreating podman container with project mount..."
  docker stop "$PODMAN_CONTAINER" 2>/dev/null || true
  docker rm "$PODMAN_CONTAINER" 2>/dev/null || true

  if ! docker volume ls | grep podman-cache > /dev/null 2>&1; then
    docker volume create podman-cache > /dev/null 2>&1
  fi

  docker run -d \
    --gpus=all \
    --name "$PODMAN_CONTAINER" \
    --device /dev/fuse \
    --mount source=podman-cache,target=/var/lib/containers \
    --volume "$HOME/.nosana/:/root/.nosana/" \
    --volume "$HOME/.nosana/podman:/podman" \
    --volume "$(pwd):$NOSANA_SRC" \
    --privileged \
    -e ENABLE_GPU=true \
    "$PODMAN_IMAGE" \
    unix:/podman/podman.sock

  echo "Waiting for podman to be ready..."
  sleep 3
fi

# Build the image inside podman
echo "Building image inside podman..."
docker exec "$PODMAN_CONTAINER" podman build --ulimit nofile=65535:65535 -t "$IMAGE_NAME" -f "$NOSANA_SRC/Dockerfile" "$NOSANA_SRC/"

# Clean up any leftover dev container
docker exec "$PODMAN_CONTAINER" podman rm -f nosana-node 2>/dev/null || true

# Create network if needed
if ! docker exec "$PODMAN_CONTAINER" podman network ls | grep NOSANA_GATEWAY > /dev/null 2>&1; then
  docker exec "$PODMAN_CONTAINER" podman network create --driver bridge --subnet=192.168.101.0/24 --gateway=192.168.101.1 NOSANA_GATEWAY > /dev/null 2>&1
fi

# Run the container inside podman with live-mounted source
echo "Running nosana-node inside podman..."
docker exec -it "$PODMAN_CONTAINER" podman run -it --rm \
  --name nosana-node \
  --network NOSANA_GATEWAY \
  --env APP_ENV=development \
  -v /root/.nosana:/root/.nosana \
  --mount type=bind,source=/podman.sock,target=/root/.nosana/podman/podman.sock \
  -v "$NOSANA_SRC/src:/nosana/src" \
  -v "$NOSANA_SRC/package.json:/nosana/package.json" \
  -v "$NOSANA_SRC/tsconfig.json:/nosana/tsconfig.json" \
  "$IMAGE_NAME" \
  "$@"
