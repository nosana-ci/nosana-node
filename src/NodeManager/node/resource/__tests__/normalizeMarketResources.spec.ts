import { describe, it, expect } from 'vitest';

import { HFResource } from '@nosana/sdk/dist/types/resources.js';
import { RequiredResource } from '@nosana/sdk';

import { normalizeMarketResources } from '../resourceManager.js';
import { createResourceName } from '../helpers/createResourceName.js';

/**
 * The market endpoint reports an HF resource's model in `url`, the field it
 * shares with S3, while the download path reads `repo`.
 */
const MARKET_HF = {
  type: 'HF',
  url: 'InternScience/Agents-A1-4B',
} as unknown as RequiredResource;

describe('normalizeMarketResources', () => {
  it('reads an HF model out of the url the market reports it in', () => {
    const [resource] = normalizeMarketResources([MARKET_HF]);

    expect((resource as HFResource).repo).toBe('InternScience/Agents-A1-4B');
  });

  it('gives the resource a name, where the unconverted shape names it "undefined"', () => {
    expect(createResourceName(MARKET_HF)).toBe('undefined');

    const [resource] = normalizeMarketResources([MARKET_HF]);

    expect(createResourceName(resource)).toBe('InternScience/Agents-A1-4B');
  });

  it('leaves an HF resource that already names its repo alone', () => {
    const jobResource = {
      type: 'HF',
      repo: 'org/model',
      revision: 'abc123',
    } as RequiredResource;

    expect(normalizeMarketResources([jobResource])).toEqual([jobResource]);
  });

  it('keeps the url on an S3 resource, whose downloader reads that field', () => {
    const s3 = {
      type: 'S3',
      url: 's3://bucket/path',
    } as RequiredResource;

    expect(normalizeMarketResources([s3])).toEqual([s3]);
  });

  it('leaves an Ollama resource, which carries no url at all, untouched', () => {
    const ollama = { type: 'Ollama', model: 'gemma4:26b' } as RequiredResource;

    expect(normalizeMarketResources([ollama])).toEqual([ollama]);
  });

  it('passes through an HF resource with neither field, for the download guard to reject', () => {
    const empty = { type: 'HF' } as unknown as RequiredResource;

    expect((normalizeMarketResources([empty])[0] as HFResource).repo).toBeUndefined();
  });
});
