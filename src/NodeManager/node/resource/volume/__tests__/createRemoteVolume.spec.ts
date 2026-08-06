import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import { RequiredResource } from '@nosana/sdk';

import { VolumeManager } from '../volumeManager.js';
import { NodeRepository } from '../../../../repository/NodeRepository.js';
import { ContainerOrchestrationInterface } from '../../../../provider/containerOrchestration/interface.js';
import { VolumeResource } from '../../../../db/index.js';

/**
 * The lifecycle around a resource download: entries recorded before the
 * download so a crash cannot orphan the volume, and failures cleaning up
 * volume and entry together.
 */

const bucketsResource = (buckets: { url: string; files?: string[] }[]) =>
  ({ type: 'S3', buckets } as unknown as RequiredResource);

const RESOURCE = bucketsResource([
  { url: 'https://pub-5bc.r2.dev/SD1.5', files: ['a.safetensors'] },
  { url: 'https://pub-5bc.r2.dev/SDXL', files: ['b.safetensors'] },
]);
const RESOURCE_NAME =
  'https://pub-5bc.r2.dev/SD1.5-https://pub-5bc.r2.dev/SDXL';

/** Encode a stderr line as a Docker multiplexed log frame, as `logs()` returns them. */
function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function makeContainer(statusCode = 0) {
  return {
    id: 'container-1',
    logs: vi.fn(async (opts: { follow?: boolean }) =>
      opts.follow ? new EventEmitter() : Buffer.alloc(0),
    ),
    wait: vi.fn(async () => ({ StatusCode: statusCode })),
    inspect: vi.fn(async () => ({
      State: { ExitCode: statusCode, OOMKilled: false },
    })),
    remove: vi.fn(async () => {}),
  };
}

function makeMocks(statusCode = 0) {
  const volumes: Record<string, VolumeResource> = {};
  const container = makeContainer(statusCode);

  const repository = {
    getVolumeResource: vi.fn((key: string) => volumes[key]),
    getVolumesResources: vi.fn(() => volumes),
    updateVolumeResource: vi.fn(
      (key: string, fields: Partial<VolumeResource>) => {
        volumes[key] = { ...volumes[key], ...fields } as VolumeResource;
      },
    ),
    deleteVolumeResource: vi.fn((key: string) => {
      delete volumes[key];
    }),
    updateOpStateError: vi.fn(),
  } as unknown as NodeRepository;

  const containerOrchestration = {
    createVolume: vi.fn(async () => ({ Name: 'fresh-volume' })),
    deleteVolume: vi.fn(async () => {}),
    runContainer: vi.fn(async () => container),
    stopAndDeleteContainer: vi.fn(async () => {}),
    hasImage: vi.fn(async () => true),
    pullImage: vi.fn(async () => {}),
  } as unknown as ContainerOrchestrationInterface;

  return { volumes, container, repository, containerOrchestration };
}

describe('createRemoteVolume', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let manager: VolumeManager;

  beforeEach(() => {
    mocks = makeMocks();
    manager = new VolumeManager(mocks.containerOrchestration, mocks.repository);
  });

  describe('pending entries', () => {
    it('records the volume before the download starts, so a crash cannot orphan it', async () => {
      let entryAtRunTime: VolumeResource | undefined;
      (
        mocks.containerOrchestration.runContainer as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => {
        entryAtRunTime = { ...mocks.volumes[RESOURCE_NAME] };
        return mocks.container;
      });

      await manager.createRemoteVolume(RESOURCE, new AbortController());

      expect(entryAtRunTime).toMatchObject({
        volume: 'fresh-volume',
        pending: true,
      });
    });

    it('clears pending once the download completes', async () => {
      await manager.createRemoteVolume(RESOURCE, new AbortController());

      expect(mocks.volumes[RESOURCE_NAME]).toMatchObject({
        volume: 'fresh-volume',
        pending: false,
        usage: 1,
      });
    });

    it('deletes the volume and its entry when the download fails', async () => {
      mocks = makeMocks(1);
      manager = new VolumeManager(
        mocks.containerOrchestration,
        mocks.repository,
      );

      await expect(
        manager.createRemoteVolume(RESOURCE, new AbortController()),
      ).rejects.toThrow('resource download failed');

      expect(mocks.containerOrchestration.deleteVolume).toHaveBeenCalledWith(
        'fresh-volume',
      );
      expect(mocks.volumes[RESOURCE_NAME]).toBeUndefined();
      // The failed download's container does not linger.
      expect(mocks.container.remove).toHaveBeenCalledWith({ force: true });
    });

    it('keeps the pending entry when the volume cannot be deleted, so it stays tracked', async () => {
      mocks = makeMocks(1);
      (
        mocks.containerOrchestration.deleteVolume as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('volume is in use'));
      manager = new VolumeManager(
        mocks.containerOrchestration,
        mocks.repository,
      );

      await expect(
        manager.createRemoteVolume(RESOURCE, new AbortController()),
      ).rejects.toThrow('resource download failed');

      expect(mocks.volumes[RESOURCE_NAME]).toMatchObject({
        volume: 'fresh-volume',
        pending: true,
      });
    });

    it('resumes a pending entry instead of creating a second volume', async () => {
      mocks.volumes[RESOURCE_NAME] = {
        volume: 'half-downloaded',
        pending: true,
        required: false,
        lastUsed: new Date(),
        usage: 0,
      };

      await manager.createRemoteVolume(RESOURCE, new AbortController());

      expect(mocks.containerOrchestration.createVolume).not.toHaveBeenCalled();
      expect(mocks.volumes[RESOURCE_NAME]).toMatchObject({
        volume: 'half-downloaded',
        pending: false,
      });
    });
  });

  describe('reported errors', () => {
    const ERRORS = [
      'Failed to download a.safetensors (512 of 4096 bytes written) - aborted (code: ECONNRESET)',
      'Failed to download b.safetensors (0 of 8192 bytes written) - terminated',
    ];

    beforeEach(() => {
      mocks = makeMocks(1);
      const stderr = Buffer.concat(
        ERRORS.map((message) =>
          frame(
            `2026-08-06T04:20:00Z ${JSON.stringify({ event: 'error', message })}\n`,
          ),
        ),
      );
      (mocks.container.logs as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { follow?: boolean }) =>
          opts.follow ? new EventEmitter() : stderr,
      );
      manager = new VolumeManager(
        mocks.containerOrchestration,
        mocks.repository,
      );
    });

    it('writes every reported error to the op state when downloading for a job', async () => {
      await expect(
        manager.createRemoteVolume(RESOURCE, new AbortController(), {
          id: 'flow-1',
          opIndex: 0,
        }),
      ).rejects.toThrow('resource download failed');

      ERRORS.forEach((message, i) => {
        expect(mocks.repository.updateOpStateError).toHaveBeenNthCalledWith(
          i + 1,
          'flow-1',
          0,
          { event: 'resource-error', message },
        );
      });
    });

    it('writes nothing for a market preload, which runs outside any job', async () => {
      await expect(
        manager.createRemoteVolume(RESOURCE, new AbortController()),
      ).rejects.toThrow('resource download failed');

      expect(mocks.repository.updateOpStateError).not.toHaveBeenCalled();
    });
  });

  describe('pullMarketRequiredVolumes', () => {
    it('re-syncs a pending entry rather than trusting it', async () => {
      mocks.volumes[RESOURCE_NAME] = {
        volume: 'half-downloaded',
        pending: true,
        required: true,
        lastUsed: new Date(),
        usage: 0,
      };

      await manager.pullMarketRequiredVolumes([RESOURCE]);

      expect(mocks.containerOrchestration.runContainer).toHaveBeenCalled();
      expect(mocks.volumes[RESOURCE_NAME]).toMatchObject({ pending: false });
    });

    it('skips a completed entry', async () => {
      mocks.volumes[RESOURCE_NAME] = {
        volume: 'complete',
        pending: false,
        required: true,
        lastUsed: new Date(),
        usage: 1,
      };

      await manager.pullMarketRequiredVolumes([RESOURCE]);

      expect(mocks.containerOrchestration.runContainer).not.toHaveBeenCalled();
    });
  });
});
