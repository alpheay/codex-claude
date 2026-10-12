import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { z } from 'zod';
import { root, stateDir, localToken } from '../src/server.ts';
import { claudeModels, mixedCatalog, openaiModels } from '../src/gateway.ts';
import { subscriptionEnvironment } from '../src/session.ts';

const provider = 'subscription-router';
const legacyProvider = 'claude-subscription';
const label = 'local.codex-claude';
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const backupPath = join(stateDir, 'config.before-claude.toml');
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid!()}`;
const keys = ['model', 'model_provider', 'model_catalog_json', 'model_reasoning_effort', 'model_reasoning_summary', 'model_context_window', 'model_auto_compact_token_limit', 'web_search', 'service_tier'];

export function configure(source: string, token: string): string {
  const config = parse(source);
  if (![...openaiModels, ...claudeModels].includes(String(config.model))) config.model = 'gpt-6-astra';
  Object.assign(config, { model_provider: provider, model_catalog_json: join(stateDir, 'mixed-models.json') });
  for (const key of ['model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary']) delete config[key];
  const providers = (config.model_providers ??= {}) as TomlTable;
  // Retry failed HTTP requests; do not automatically replay interrupted response streams.
  providers[provider] = { name: 'Local subscriptions', base_url: 'http://127.0.0.1:19382/gateway', wire_api: 'responses', supports_websockets: false, requires_openai_auth: true, request_max_retries: 8, stream_max_retries: 0, http_headers: { 'X-Codex-Claude-Key': token } };
  return stringify(config);
}

export function restore(source: string, backup: string): string {
  const current = parse(source);
  const previous = parse(backup);
  for (const key of keys) {
    if (key in previous) current[key] = previous[key];
    else delete current[key];
  }
  const providers = (current.model_providers ?? {}) as TomlTable;
  const oldProviders = (previous.model_providers ?? {}) as TomlTable;
  for (const name of [provider, legacyProvider]) {
    if (name in oldProviders) providers[name] = oldProviders[name];
    else delete providers[name];
  }
  if (Object.keys(providers).length === 0) delete current.model_providers;
  return stringify(current);
}

async function atomicWrite(path: string, content: string) {
  await writeFile(`${path}.codex-claude.tmp`, content, { mode: 0o600 });
  await rename(`${path}.codex-claude.tmp`, path);
}

async function health() {
  const token = await localToken(stateDir);
  const response = await fetch('http://127.0.0.1:19382/health', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
  assert.ok(response.ok, `Adapter health failed: ${response.status}`);
  const data = z.object({ service: z.string(), pid: z.number() }).parse(await response.json());
  assert.equal(data.service, 'codex-claude');
  return data.pid;
}

async function preflight() {
  assert.equal(process.platform, 'darwin', 'Automatic installation supports macOS.');
  const source = await readFile(configPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('Open Codex and sign in before setup; its config.toml must exist.');
    throw error;
  });
  parse(source);
  const catalog = JSON.parse(await readFile(join(root, 'config/models.json'), 'utf8'));
  const native = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
  const models = mixedCatalog(catalog, native);
  const found = spawnSync('/usr/bin/which', ['claude'], { encoding: 'utf8' });
  const claude = process.env.CODEX_CLAUDE_CLI ?? found.stdout?.trim();
  assert.ok(claude, 'Install Claude Code and make claude available on PATH, or set CODEX_CLAUDE_CLI.');
  const auth = spawnSync(claude, ['auth', 'status', '--json'], { encoding: 'utf8', env: subscriptionEnvironment(), timeout: 15_000 });
  assert.ok(!auth.error, 'Could not run Claude Code. Check CODEX_CLAUDE_CLI and run claude auth status.');
  assert.equal(auth.status, 0, 'Claude login is unavailable. Run claude auth login with your subscription, then retry setup.');
  let account: unknown;
  try { account = JSON.parse(auth.stdout); }
  catch { throw new Error('Could not read Claude login status. Update Claude Code and run claude auth status.'); }
  const subscription = z.object({ loggedIn: z.literal(true), authMethod: z.literal('claude.ai'), apiProvider: z.literal('firstParty'), subscriptionType: z.string().min(1) });
  assert.ok(subscription.safeParse(account).success, 'A Claude subscription login is required. Run claude auth login; API-key login is not supported.');
  return { source, claude, models };
}

async function startService(claude: string) {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await atomicWrite(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(join(root, 'src/server.ts'))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>CODEX_CLAUDE_CLI</key><string>${escape(claude)}</string><key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escape(join(stateDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(stateDir, 'service.log'))}</string>
</dict></plist>\n`);
  if (spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status !== 0) execFileSync('launchctl', ['bootstrap', domain, plistPath]);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const pid = await health();
      const service = execFileSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
      assert.equal(Number(service.match(/\bpid = (\d+)/)?.[1]), pid, 'Port 19382 is occupied by a different process. Stop npm start before installing.');
      return;
    }
    catch (error) { if (attempt === 19) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
}

async function main() {
  const mode = process.argv[2] ?? 'enable';
  assert.ok(['enable', 'check', 'disable', 'status', 'uninstall'].includes(mode), 'Use npm run setup -- enable|check|disable|status|uninstall');
  assert.equal(stateDir, join(root, '.local'), 'Setup requires the default state directory.');
  assert.ok(!process.env.CODEX_CLAUDE_PORT || process.env.CODEX_CLAUDE_PORT === '19382', 'Setup requires port 19382.');
  if (mode === 'status') {
    await health();
    console.log(`Adapter healthy. Configured provider: ${parse(await readFile(configPath, 'utf8')).model_provider ?? 'openai'}`);
    return;
  }
  if (mode === 'enable' || mode === 'check') {
    const { source, claude, models } = await preflight();
    if (mode === 'check') {
      console.log('Prerequisites ready. No settings changed and no model request sent. Run npm run setup to install.');
      return;
    }
    const currentProvider = parse(source).model_provider;
    if (currentProvider === provider || currentProvider === legacyProvider) await readFile(backupPath);
    const baseline = currentProvider === legacyProvider ? restore(source, await readFile(backupPath, 'utf8')) : source;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    if (currentProvider !== provider && currentProvider !== legacyProvider) await atomicWrite(backupPath, source);
    await atomicWrite(join(stateDir, 'mixed-models.json'), JSON.stringify(models));
    await startService(claude);
    assert.equal(await readFile(configPath, 'utf8'), source, 'Codex config changed during installation. Retry setup.');
    await atomicWrite(configPath, configure(baseline, await localToken(stateDir)));
    console.log(`Claude and Codex models enabled. Backup: ${backupPath}\nRestart the desktop app. Each chat stays with its initial provider.`);
    return;
  }
  const source = await readFile(configPath, 'utf8');
  if ([provider, legacyProvider].includes(String(parse(source).model_provider))) {
    const backup = await readFile(backupPath, 'utf8');
    await atomicWrite(configPath, restore(source, backup));
  }
  if (mode === 'uninstall') {
    const loaded = spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0;
    if (loaded) execFileSync('launchctl', ['bootout', `${domain}/${label}`]);
    await rm(plistPath, { force: true });
  }
  console.log(`Previous model settings restored. Restart the desktop app. ${mode === 'uninstall' ? 'Login service removed; session files retained.' : 'The local service remains available for re-enabling.'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
