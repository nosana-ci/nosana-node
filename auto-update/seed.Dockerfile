# The auto-update wrapper, carrying the node from this checkout packed as the
# version after the one on npm (or as VERSIONS, comma-separated), to exercise
# the coming release's update cycle without publishing anything.
# seed.compose.yml builds and runs it; by hand, from the repository root:
#
#   docker build -f auto-update/seed.Dockerfile -t nosana-auto-update-seed .
#   docker run --rm \
#     --volume /root/.nosana/:/root/.nosana/ \
#     --volume /var/run/docker.sock:/var/run/docker.sock \
#     nosana-auto-update-seed start --network devnet
#
# The version on npm is installed first (or NOSANA_NODE_INITIAL_VERSION, when
# set), from the registry unless packed too, and its successor is packed:
# 1.1.49 and 1.1.50 with 1.1.49 on `latest`, or with --build-arg DIST_TAG=next
# 1.1.50-rc and 1.1.51-rc with 1.1.50-rc on `next`. Any version the wrapper installs
# comes from here when packed and from the registry when not. seed.hijack.mjs,
# preloaded into the node, has its registry lookup report the packed versions
# as released, so the one after npm's is asked for like any other. The node
# defers its startup version check while it is the initial version, so it
# reaches the job loop and asks for the update from there.

FROM node:20.11.1 AS tarballs

WORKDIR /node
COPY . .
RUN npm ci && npm run build

# The channel: `latest`, or `next` for the release candidates, whose versions
# carry an -rc suffix the packed one keeps.
ARG DIST_TAG=latest
ARG VERSIONS
# npm ignores the shrinkwrap when installing a tarball from disk, so bundle the
# dependencies rather than let it resolve them afresh into a tree that may not
# run. The node reads its version from the copy of package.json that the build
# put in dist, so that is stamped alongside.
RUN mkdir /tarballs \
 && latest=$(npm view @nosana/node dist-tags.$DIST_TAG) && echo "$latest" > /tarballs/npm-latest \
 && base=${latest%-rc} && suffix=${latest#"$base"} \
 && pack=${VERSIONS:-${base%.*}.$(( ${base##*.} + 1 ))$suffix} \
 && echo "Packing $pack" \
 && npm pkg set bundleDependencies=true --json \
 && for version in $(echo "$pack" | tr ',' ' '); do \
      npm pkg set version="$version" && cp package.json dist/ \
      && npm pack --ignore-scripts --pack-destination /tarballs || exit 1; \
    done

FROM node:20.11.1

WORKDIR /nosana
COPY auto-update .
RUN npm ci \
 && npm run build \
 && npm ci --omit=dev
ENV NODE_ENV=production
ENV APP_ENV=prd

COPY --from=tarballs /tarballs /tarballs
ENV NOSANA_NODE_TARBALL_DIR=/tarballs
ENV NODE_OPTIONS=--import=/nosana/seed.hijack.mjs

ENTRYPOINT ["sh", "-c", "NOSANA_NODE_INITIAL_VERSION=${NOSANA_NODE_INITIAL_VERSION:-$(cat /tarballs/npm-latest)} exec node dist/src/index.js \"$@\"", "--"]
