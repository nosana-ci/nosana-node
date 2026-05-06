import { NodeConfigsSingleton } from './NodeConfigs.js';
import { loadConfigurationValue } from '../utils/utils.js';

export type configType = {
  isNodeRun: boolean;
  hostManagerBaseUrl: string;
  explorerUrl: string;
  signMessage: string;
  frp: {
    serverAddr: string;
    serverPort: number;
    containerImage: string;
    nodeInternalHostName: string;
  };
  api: {
    port: number;
  };
  minDiskSpace: number;
  network: 'devnet' | 'mainnet';
};

export const configs = (options?: { [key: string]: any }): configType => {
  NodeConfigsSingleton.getInstance(options);

  return {
    isNodeRun: options?.isNodeRun,
    hostManagerBaseUrl: loadConfigurationValue('HOST_MANAGER_BASE_URL'),
    explorerUrl: loadConfigurationValue('EXPLORER_URL'),
    signMessage: loadConfigurationValue('SIGN_MESSAGE'),
    frp: {
      serverAddr: loadConfigurationValue('FRP_SERVER_ADDRESS'),
      serverPort: parseInt(loadConfigurationValue('FRP_SERVER_PORT')),
      containerImage: loadConfigurationValue('FRP_SERVER_IMAGE'),
      nodeInternalHostName: loadConfigurationValue('FRP_NODE_INTERNAL_HOSTNAME', "nosana-node"),
    },
    api: {
      port: parseInt(loadConfigurationValue('API_PORT')),
    },
    minDiskSpace: parseInt(loadConfigurationValue('MIN_DISK_SPACE')),
    network: options?.network ?? 'mainnet',
  };
};
