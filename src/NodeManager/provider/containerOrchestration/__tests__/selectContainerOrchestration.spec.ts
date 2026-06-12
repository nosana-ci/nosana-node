import { describe, it, expect } from 'vitest';

import { selectContainerOrchestrationProvider } from '../selectContainerOrchestration.js';

describe('selectContainerOrchestrationProvider', () => {
  it('throws for podman with SEV-SNP', () => {
    expect(() =>
      selectContainerOrchestrationProvider(
        'podman',
        'http://localhost:2375',
        'all',
        'SEV-SNP',
      ),
    ).toThrow('Custom runtimes are only supported with the Docker provider.');
  });

  it('passes SEV-GUEST through to podman', () => {
    const orchestration = selectContainerOrchestrationProvider(
      'podman',
      'http://localhost:2375',
      'all',
      'SEV-GUEST',
    );
    expect(orchestration.name).toBe('podman');
    expect(orchestration.teeRuntime).toBe('SEV-GUEST');
  });

  it('passes the TEE runtime through to docker', () => {
    const orchestration = selectContainerOrchestrationProvider(
      'docker',
      'http://localhost:2375',
      'all',
      'SEV-SNP',
    );
    expect(orchestration.teeRuntime).toBe('SEV-SNP');
  });
});
