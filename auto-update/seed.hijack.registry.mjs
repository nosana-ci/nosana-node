// Two roles, see seed.hijack.mjs: the loader hook that redirects the node's
// registry module here, and the module that stands in for it.
import fs from 'node:fs';

const TARGET = /\/dist\/src\/version\/registry\.js$/;
const SELF = new URL(import.meta.url);
SELF.search = '';

/** Loader hook: the registry module resolves here, with the real one's URL. */
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const fromHere = context.parentURL?.startsWith(SELF.href);
  if (fromHere || !TARGET.test(resolved.url)) return resolved;

  const url = new URL(SELF);
  url.searchParams.set('original', resolved.url);
  return { ...resolved, url: url.href, shortCircuit: true };
}

const parts = (version) => version.split('.').map((part) => parseInt(part));

/** Major, then minor, then patch; a `-rc` suffix does not count. */
function isNewer(candidate, current) {
  const [cMajor, cMinor, cPatch] = parts(candidate);
  const [major, minor, patch] = parts(current);
  if (cMajor !== major) return cMajor > major;
  if (cMinor !== minor) return cMinor > minor;
  return cPatch > patch;
}

function packedVersions() {
  const dir = process.env.NOSANA_NODE_TARBALL_DIR;
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .map((file) => /^nosana-node-(.+)\.tgz$/.exec(file)?.[1])
    .filter(Boolean);
}

/** The dist-tags with `latest` and `next` raised to what is packed. */
function raise(distTags) {
  const raised = { ...distTags };
  for (const version of packedVersions()) {
    const tag = version.includes('-rc') ? 'next' : 'latest';
    if (!raised[tag] || isNewer(version, raised[tag])) raised[tag] = version;
  }
  return raised;
}

/** Stand-in for the registry module: the real answer, raised. */
const original = new URL(import.meta.url).searchParams.get('original');
const real = original ? await import(original) : undefined;

export async function fetchDistTags(name) {
  return raise((await real.fetchDistTags(name)) ?? {});
}
