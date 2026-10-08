/**
 * Runner del pipeline E1 de Cursor Trading:
 * - powershell: Windows, scripts/analyze/analyze-<market>-<tier>.ps1
 * - bash: Android (Termux + proot Ubuntu) / Linux, scripts/analyze/analyze.sh
 * - none: contenedor sin Python/stack (solo UI/health)
 */
const path = require('node:path');

const RUNNERS = new Set(['powershell', 'bash', 'none']);

/** SIGNAL_RUNNER explícito gana; si no, Windows = powershell y el resto = none. */
function resolveSignalRunner(envValue, platform) {
  const v = String(envValue || '').trim().toLowerCase();
  if (RUNNERS.has(v)) return v;
  return platform === 'win32' ? 'powershell' : 'none';
}

function signalScriptPath(tradingRoot, runner, market, tier) {
  const dir = path.join(tradingRoot, 'scripts', 'analyze');
  if (runner === 'bash') return path.join(dir, 'analyze.sh');
  return path.join(dir, `analyze-${market}-${tier}.ps1`);
}

/**
 * Comando a spawnear. Los flags son estilo PowerShell (-ML, -Entry 123);
 * analyze.sh los acepta tal cual.
 * @returns {{ cmd: string, args: string[] }}
 */
function signalSpawnSpec(runner, scriptResolved, market, tier, psArgs, env = process.env) {
  if (runner === 'bash') {
    return {
      cmd: env.BASH_EXE || 'bash',
      args: [scriptResolved, market, tier, ...psArgs],
    };
  }
  return {
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptResolved, ...psArgs],
  };
}

function signalCommandLine(spec) {
  const quoted = spec.args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return [spec.cmd.replace(/\.exe$/i, ''), ...quoted].join(' ');
}

module.exports = {
  RUNNERS,
  resolveSignalRunner,
  signalScriptPath,
  signalSpawnSpec,
  signalCommandLine,
};
