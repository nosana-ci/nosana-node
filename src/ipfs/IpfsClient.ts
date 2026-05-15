import {
  createIpfsClient,
  type IPFSConfig,
  type NosanaIpfsClient,
} from '@nosana/ipfs';

let instance: NosanaIpfsClient | null = null;

function getInstance(): NosanaIpfsClient {
  if (!instance) {
    throw new Error(
      'IpfsClient has not been initialized. Call IpfsClientSingleton.set() first.',
    );
  }
  return instance;
}

export const IpfsClientSingleton = {
  set(config?: Partial<IPFSConfig>): NosanaIpfsClient {
    instance = createIpfsClient(config);
    return instance;
  },
  pin: (data: object) => getInstance().pin(data),
  pinFile: (path: string) => getInstance().pinFile(path),
  retrieve: <T>(hash: string | Array<number>) => getInstance().retrieve<T>(hash),
};
