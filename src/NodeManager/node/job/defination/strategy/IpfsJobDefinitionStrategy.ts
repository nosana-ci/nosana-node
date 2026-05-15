import { JobDefinition } from '@nosana/sdk';
import { JobDefinitionStrategy } from '../JobDefinitionStrategy.js';
import { IpfsClientSingleton } from '../../../../../ipfs/IpfsClient.js';

export class IpfsJobDefinitionStrategy implements JobDefinitionStrategy {
  async load(id: string): Promise<JobDefinition> {
    try {
      return await IpfsClientSingleton.retrieve(id);
    } catch (e) {
      throw new Error(`Failed to load job from IPFS: ${(e as any).message}`);
    }
  }
}
