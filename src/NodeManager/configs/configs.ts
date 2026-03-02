import { NodeConfigsSingleton } from './NodeConfigs.js';
import { loadConfigurationValue } from '../utils/utils.js';

export type configType = {
  isNodeRun: boolean;
  backendUrl: string;
  backendSolanaAddress: string;
  backendAuthorizationAddress: string;
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
  spinnerInterval: number;
};

export const configs = (options?: { [key: string]: any }): configType => {
  NodeConfigsSingleton.getInstance(options);

  return {
    isNodeRun: options?.isNodeRun,
    backendUrl: loadConfigurationValue('BACKEND_URL'),
    backendSolanaAddress: loadConfigurationValue('BACKEND_SOLANA_ADDRESS'),
    backendAuthorizationAddress: loadConfigurationValue(
      'BACKEND_AUTHORIZATION_ADDRESS',
    ),
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
    spinnerInterval: parseInt(loadConfigurationValue('SPINNER_INTERVAL', '5000')),
  };
};
