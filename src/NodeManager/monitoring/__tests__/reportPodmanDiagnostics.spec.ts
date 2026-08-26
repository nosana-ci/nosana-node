import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const reportError = vi.fn();
vi.mock('../reportError.js', () => ({ reportError }));

const { reportPodmanDiagnostics } = await import('../reportPodmanDiagnostics.js');

const reported = () =>
  reportError.mock.calls.map(([r]) => [r.error_type, r.error_message]);

describe('reportPodmanDiagnostics', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-'));
    reportError.mockClear();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports nothing when the podman container has written no events', () => {
    reportPodmanDiagnostics(dir);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports events written for the first time after the node started', async () => {
    reportPodmanDiagnostics(dir);

    fs.writeFileSync(path.join(dir, 'cdi-events.log'), '{"event":"repaired"}\n');

    await vi.waitFor(() =>
      expect(reported()).toEqual([['cdiEvent', '{"event":"repaired"}']]),
    );
  });

  it('holds an incomplete line until the newline ending it arrives', async () => {
    const log = path.join(dir, 'cdi-events.log');
    reportPodmanDiagnostics(dir);

    fs.appendFileSync(log, '{"event":"rep');
    fs.appendFileSync(log, 'aired"}\n');

    await vi.waitFor(() =>
      expect(reported()).toEqual([['cdiEvent', '{"event":"repaired"}']]),
    );
  });

  it('starts over when the log is replaced with the podman container', async () => {
    const log = path.join(dir, 'cdi-events.log');
    fs.writeFileSync(log, '{"event":"unrepairable"}\n{"event":"repaired"}\n');

    reportPodmanDiagnostics(dir);
    expect(reported()).toHaveLength(2);

    fs.rmSync(log);
    fs.writeFileSync(log, '{"event":"fresh"}\n');

    await vi.waitFor(() =>
      expect(reported().at(-1)).toEqual(['cdiEvent', '{"event":"fresh"}']),
    );
  });

  it('starts over when the log is replaced by one of the same size', async () => {
    const log = path.join(dir, 'cdi-events.log');
    fs.writeFileSync(log, '{"event":"aaaa"}\n');

    reportPodmanDiagnostics(dir);
    expect(reported()).toEqual([['cdiEvent', '{"event":"aaaa"}']]);

    fs.rmSync(log);
    fs.writeFileSync(log, '{"event":"bbbb"}\n');

    await vi.waitFor(() =>
      expect(reported().at(-1)).toEqual(['cdiEvent', '{"event":"bbbb"}']),
    );
  });

  it('does not throw when the config directory is not there', () => {
    expect(() =>
      reportPodmanDiagnostics(path.join(dir, 'gone')),
    ).not.toThrow();
  });

  it('does not throw when no config location was given', () => {
    expect(() => reportPodmanDiagnostics('')).not.toThrow();
  });

  it('survives the config directory being removed while watching', async () => {
    reportPodmanDiagnostics(dir);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reportError).not.toHaveBeenCalled();
  });

  it('gives up on a log that has run far ahead rather than reading it whole', () => {
    const log = path.join(dir, 'cdi-events.log');
    fs.writeFileSync(log, `${'{"event":"old"}\n'.repeat(80_000)}`);

    reportPodmanDiagnostics(dir);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports events already present, then each one appended after', async () => {
    const log = path.join(dir, 'cdi-events.log');
    fs.writeFileSync(log, '{"event":"repaired"}\n');

    reportPodmanDiagnostics(dir);
    expect(reported()).toEqual([['cdiEvent', '{"event":"repaired"}']]);

    fs.appendFileSync(log, '{"event":"unrepairable"}\n');

    await vi.waitFor(() =>
      expect(reported()).toEqual([
        ['cdiEvent', '{"event":"repaired"}'],
        ['cdiEvent', '{"event":"unrepairable"}'],
      ]),
    );
  });
});
