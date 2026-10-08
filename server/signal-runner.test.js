/**
 * Tests del runner de señales: powershell (Windows) / bash (Android) / none.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveSignalRunner,
  signalScriptPath,
  signalSpawnSpec,
  signalCommandLine,
} = require('./signal-runner');

describe('resolveSignalRunner', () => {
  it('Windows sin env → powershell', () => {
    assert.equal(resolveSignalRunner(undefined, 'win32'), 'powershell');
  });

  it('Linux / Android sin env → none (Docker conserva el 503)', () => {
    assert.equal(resolveSignalRunner('', 'linux'), 'none');
    assert.equal(resolveSignalRunner(undefined, 'android'), 'none');
  });

  it('SIGNAL_RUNNER explícito gana (case-insensitive)', () => {
    assert.equal(resolveSignalRunner('BASH', 'linux'), 'bash');
    assert.equal(resolveSignalRunner('none', 'win32'), 'none');
  });

  it('valor desconocido cae al default de la plataforma', () => {
    assert.equal(resolveSignalRunner('zsh', 'win32'), 'powershell');
    assert.equal(resolveSignalRunner('zsh', 'linux'), 'none');
  });
});

describe('signalScriptPath', () => {
  const root = path.join('trading', 'Cursor Trading');

  it('powershell → analyze-<market>-<tier>.ps1', () => {
    assert.equal(
      signalScriptPath(root, 'powershell', 'us30', 'high'),
      path.join(root, 'scripts', 'analyze', 'analyze-us30-high.ps1')
    );
  });

  it('bash → analyze.sh único para todos los mercados', () => {
    assert.equal(
      signalScriptPath(root, 'bash', 'btc', 'light'),
      path.join(root, 'scripts', 'analyze', 'analyze.sh')
    );
  });
});

describe('signalSpawnSpec', () => {
  it('bash pasa market y tier antes de los flags', () => {
    const spec = signalSpawnSpec('bash', '/t/analyze.sh', 'btc', 'high', ['-ML', '-Entry', '97450.5'], {});
    assert.deepEqual(spec, {
      cmd: 'bash',
      args: ['/t/analyze.sh', 'btc', 'high', '-ML', '-Entry', '97450.5'],
    });
  });

  it('BASH_EXE sobreescribe el ejecutable', () => {
    const spec = signalSpawnSpec('bash', '/t/analyze.sh', 'btc', 'light', [], { BASH_EXE: '/bin/bash' });
    assert.equal(spec.cmd, '/bin/bash');
  });

  it('powershell conserva -File y los flags', () => {
    const spec = signalSpawnSpec('powershell', 'C:\\x\\a.ps1', 'btc', 'high', ['-NoChart']);
    assert.equal(spec.cmd, 'powershell.exe');
    assert.deepEqual(spec.args.slice(-3), ['-File', 'C:\\x\\a.ps1', '-NoChart']);
  });
});

describe('signalCommandLine', () => {
  it('entrecomilla rutas con espacios y quita .exe', () => {
    const line = signalCommandLine({
      cmd: 'powershell.exe',
      args: ['-File', 'D:\\Cursor Trading\\a.ps1', '-ML'],
    });
    assert.equal(line, 'powershell -File "D:\\Cursor Trading\\a.ps1" -ML');
  });
});
