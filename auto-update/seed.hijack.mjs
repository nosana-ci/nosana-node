// Preloaded into every node process of the seed image (NODE_OPTIONS in
// seed.Dockerfile). Registers a loader hook that swaps the node's registry
// lookup, dist/src/version/registry.js, for seed.hijack.registry.mjs, which
// asks the real one and raises the dist-tags to the versions packed in the
// image. Nothing else in the process is touched.
import { register } from 'node:module';

register('./seed.hijack.registry.mjs', import.meta.url);
