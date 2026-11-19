// gate/deploy.js — DeployGate: the deploy gate.
//
// Flow:
//   1. Pre-check: `kane-cli whoami` must show a logged-in identity.
//      If Kane CLI is not logged in, the gate FAILS CLOSED with a clear
//      message — it never fakes a pass.
//   2. Start the demo app on localhost with a fresh board (data.json reset).
//   3. Run `kane-cli run "<objective>" --headless --agent` against the app.
//   4. Read the NDJSON verdict + Kane exit code (0=pass, 1=fail, 2=error,
//      3=timeout). PASS only if exit code is 0 AND no NDJSON verdict says
//      failed — when in doubt, the deploy is blocked.
//   5. PASS  -> copy the app into dist/ and write deploy-record.json.
//      FAIL  -> block the deploy, write kane-report.md, exit non-zero.
//
// Usage:
//   npm run gate                          (uses tests/deploy-flow.testmd)
//   node gate/deploy.js --objective tests/happy-path.testmd --port 4173
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OBJECTIVE = path.join(ROOT, 'tests', 'deploy-flow.testmd');
const KANE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function parseArgs(argv) {
  const args = { objective: DEFAULT_OBJECTIVE, port: 4173 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--objective' && argv[i + 1]) args.objective = path.resolve(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node gate/deploy.js [--objective <file.testmd>] [--port <n>]');
      process.exit(0);
    }
  }
  return args;
}

// Extract the plain-English objective from a .testmd file: the text under
// the "## Objective" heading, or the whole file with headings stripped.
function readObjective(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/## Objective\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  const text = (m ? m[1] : raw)
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
  if (!text) throw new Error(`no objective found in ${file}`);
  return text;
}

// The VM's NO_PROXY contains bracketed IPv6 entries ("[::1]",
// "[fd8b:...]") which break Kane CLI's proxy/URL parsing with
// "Invalid port: ':1]'". Strip bracketed entries for Kane child
// processes; localhost/127.0.0.1 stay bypassed. (Found 19 Nov 2026:
// with the stock NO_PROXY every Kane run dies after ~60 s with that
// error; with bracket-free NO_PROXY the run passes.)
function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    if (!env[key]) continue;
    env[key] = env[key].split(',').map((s) => s.trim()).filter((s) => s && !s.includes('[')).join(',');
  }
  // Kane needs a real Chrome binary; this VM has none at
  // /usr/bin/google-chrome. Prefer a Playwright Chromium build, else the
  // Muse browser binary. (19 Nov 2026: the headless shell works too, but
  // the full Chromium build is the safer default.)
  if (!env.KANE_CLI_CHROME_PATH) {
    const home = process.env.HOME || '';
    const candidates = [];
    try {
      const pwDir = path.join(home, '.cache', 'ms-playwright');
      for (const d of fs.readdirSync(pwDir)) {
        if (/^chromium-\d+$/.test(d)) candidates.push(path.join(pwDir, d, 'chrome-linux64', 'chrome'));
        if (/^chromium_headless_shell-\d+$/.test(d)) candidates.push(path.join(pwDir, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      }
    } catch { /* no playwright cache */ }
    candidates.push('/opt/meta-chromium/chrome');
    const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (found) env.KANE_CLI_CHROME_PATH = found;
  }
  return env;
}

function runSync(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, env: sanitizedEnv() });
  } catch (err) {
    return { error: err, stdout: '', stderr: '' };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

function writeReport({ objective, objectiveFile, exitCode, verdict, summary, evidenceUrl, blockedReason }) {
  const lines = [
    '# Kane report — DeployGate',
    '',
    `- Timestamp: ${new Date().toISOString()}`,
    `- Objective file: ${objectiveFile}`,
    `- Objective: ${objective}`,
    `- Kane exit code: ${exitCode} (${exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : exitCode === 2 ? 'error' : exitCode === 3 ? 'timeout' : 'unknown'})`,
    `- Verdict: ${verdict}`,
    `- Evidence: ${evidenceUrl || '(no share link captured — see console output above)'}`,
    '',
    '## Result',
    '',
    blockedReason
      ? `⛔ **Deploy BLOCKED.** ${blockedReason}`
      : '✅ **Deploy allowed.** Kane CLI passed the objective.',
    '',
    '## Failure summary',
    '',
    summary || '(no output captured)',
    '',
  ];
  fs.writeFileSync(path.join(ROOT, 'kane-report.md'), lines.join('\n'));
}

// Parse Kane --agent NDJSON output: look for a verdict field anywhere, and
// for an evidence/share URL. Returns { verdict, evidenceUrl } where verdict
// is 'passed' | 'failed' | 'error' | null.
function parseKaneOutput(stdout) {
  let verdict = null;
  let evidenceUrl = null;
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(urlRe);
    if (urls) {
      const hit = urls.find((u) => /testmuai|evidence|share|run/i.test(u));
      if (hit && !evidenceUrl) evidenceUrl = hit;
    }
    let obj = null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidates = [obj.verdict, obj.result, obj.status, obj.outcome];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const v = c.toLowerCase();
      if (['passed', 'pass', 'success'].includes(v)) verdict = 'passed';
      else if (['failed', 'fail', 'failure'].includes(v)) verdict = 'failed';
      else if (['error', 'errored'].includes(v)) verdict = 'error';
    }
    if (obj.passed === true) verdict = 'passed';
    if (obj.passed === false) verdict = 'failed';
  }
  return { verdict, evidenceUrl };
}

async function main() {
  const { objective, port } = parseArgs(process.argv.slice(2));
  const appUrl = `http://localhost:${port}`;
  // The .testmd objectives use {APP_URL} so the gate port stays configurable.
  const objectiveText = readObjective(objective).replaceAll('{APP_URL}', appUrl);

  console.log('== DeployGate ==');
  console.log(`Objective file: ${objective}`);
  console.log(`Objective: ${objectiveText}`);
  console.log(`App URL: ${appUrl}`);
  console.log('');

  // 1. Pre-check: Kane CLI login. Fail closed if not logged in.
  console.log('[1/4] Checking Kane CLI login…');
  const whoami = runSync('kane-cli', ['whoami']);
  const whoamiOut = `${whoami.stdout || ''}\n${whoami.stderr || ''}`;
  if (whoami.error || /not logged in/i.test(whoamiOut) || whoami.status !== 0) {
    const reason = 'Kane CLI belum login. Jalankan `kane-cli login` dengan akun TestMu AI yang sama dengan akun hackathon (ricoandriansy17@gmail.com), lalu jalankan gate lagi. Deploy TIDAK dilanjutkan tanpa verdict Kane yang asli.';
    console.error(`\n⛔ ${reason}\n`);
    writeReport({
      objective: objectiveText,
      objectiveFile: objective,
      exitCode: 2,
      verdict: 'error',
      summary: whoamiOut.trim().slice(-2000) || '(no output)',
      evidenceUrl: null,
      blockedReason: reason,
    });
    console.error('Report written to kane-report.md');
    process.exit(2);
  }
  console.log('Kane CLI is logged in.\n');

  // 2. Start the app with a fresh board so the run is deterministic.
  console.log('[2/4] Starting the app (fresh board)…');
  const dataFile = path.join(ROOT, 'data.json');
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stopServer = () => {
    if (!server.killed) server.kill('SIGTERM');
  };
  process.on('SIGINT', () => { stopServer(); process.exit(130); });

  try {
    const up = await waitForHealth(port);
    if (!up) {
      console.error('⛔ App did not become healthy in time.');
      console.error(serverLog.slice(-2000));
      process.exit(2);
    }
    console.log(`App is up at ${appUrl}\n`);

    // 3. Run Kane CLI.
    console.log('[3/4] Running Kane CLI…');
    const kane = spawn('kane-cli', ['run', objectiveText, '--headless', '--agent'], { stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv() });
    let stdout = '';
    let stderr = '';
    kane.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    kane.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        kane.kill('SIGKILL');
        resolve(3); // timeout, mirrors Kane exit code 3
      }, KANE_TIMEOUT_MS);
      kane.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === null ? 3 : code);
      });
      kane.on('error', () => {
        clearTimeout(timer);
        resolve(2);
      });
    });
    console.log(`\nKane exit code: ${exitCode}`);

    // 4. Verdict: exit code is authoritative; an NDJSON "failed" overrides
    //    a 0 exit code — never fake a pass.
    const combined = `${stdout}\n${stderr}`;
    if (/not logged in|login required|unauthori[sz]ed|please run `?kane-cli login/i.test(combined)) {
      const reason = 'Kane CLI belum login (auth gagal saat run). Jalankan `kane-cli login` lalu ulangi gate. Deploy TIDAK dilanjutkan.';
      console.error(`\n⛔ ${reason}\n`);
      writeReport({
        objective: objectiveText, objectiveFile: objective, exitCode, verdict: 'error',
        summary: combined.trim().slice(-3000), evidenceUrl: null, blockedReason: reason,
      });
      process.exit(2);
    }

    const { verdict: ndjsonVerdict, evidenceUrl } = parseKaneOutput(stdout);
    const ndjsonFailed = ndjsonVerdict === 'failed' || ndjsonVerdict === 'error';
    const passed = exitCode === 0 && !ndjsonFailed;
    const verdict = ndjsonVerdict || (exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : exitCode === 3 ? 'timeout' : 'error');

    console.log(`[4/4] Verdict: ${verdict} (NDJSON: ${ndjsonVerdict || 'none'}, exit: ${exitCode})`);

    if (passed) {
      // Deploy: copy the app into dist/ and record the verdict.
      const distDir = path.join(ROOT, 'dist');
      if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
      fs.mkdirSync(distDir, { recursive: true });
      fs.cpSync(path.join(ROOT, 'public'), path.join(distDir, 'public'), { recursive: true });
      for (const f of ['server.js', 'package.json']) {
        fs.copyFileSync(path.join(ROOT, f), path.join(distDir, f));
      }
      const record = {
        timestamp: new Date().toISOString(),
        verdict: 'pass',
        objective: objectiveText,
        objectiveFile: path.relative(ROOT, objective),
        kaneExitCode: exitCode,
        evidenceUrl: evidenceUrl || null,
        appUrl,
      };
      fs.writeFileSync(path.join(ROOT, 'deploy-record.json'), JSON.stringify(record, null, 2));
      console.log('\n✅ DEPLOY DIIZINKAN — Kane CLI passed.');
      console.log(`   Build copied to dist/`);
      console.log(`   Record written to deploy-record.json`);
      if (evidenceUrl) console.log(`   Evidence: ${evidenceUrl}`);
      process.exit(0);
    }

    // FAIL / ERROR / TIMEOUT — block the deploy.
    const reason = exitCode === 1
      ? 'Kane CLI melaporkan kegagalan (assertion tidak terpenuhi). Perbaiki aplikasi / checklist, lalu jalankan gate lagi.'
      : exitCode === 3
        ? 'Kane CLI timeout. Periksa apakah app masih merespons, lalu jalankan gate lagi.'
        : 'Kane CLI error. Periksa output di atas, lalu jalankan gate lagi.';
    console.error(`\n⛔ DEPLOY DIBLOKIR. ${reason}\n`);
    writeReport({
      objective: objectiveText,
      objectiveFile: objective,
      exitCode,
      verdict,
      summary: combined.trim().slice(-3000) || '(no output captured)',
      evidenceUrl,
      blockedReason: reason,
    });
    console.error('Report written to kane-report.md');
    process.exit(exitCode === 0 ? 1 : exitCode);
  } finally {
    stopServer();
  }
}

main().catch((err) => {
  console.error(`Gate crashed: ${err.message}`);
  process.exit(2);
});
