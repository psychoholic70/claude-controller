#!/usr/bin/env node
// claude-bridge: lets Codex use Claude Code (`claude -p`) as an independent controller
// for review, test, verify, gate and delegated tasks. Prompts live in prompts.mjs.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPrompt, SCHEMA } from './prompts.mjs';

const SELF = fileURLToPath(import.meta.url);
const IS_WIN = process.platform === 'win32';
const LONG_DASH = String.fromCharCode(0x2014);

const DEFAULT_MODEL = {
  review: 'opus', 'adversarial-review': 'opus', task: 'opus',
  test: 'sonnet', verify: 'sonnet', gate: 'sonnet',
};
const STRUCTURED = new Set(['review', 'adversarial-review', 'test', 'verify']);

const READ_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git ls-files:*)', 'Bash(git blame:*)', 'Bash(git grep:*)', 'Bash(git rev-parse:*)',
];
const TEST_TOOLS = [
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(node:*)',
  'Bash(npx tsc:*)', 'Bash(npx eslint:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)',
  'Bash(npx playwright test:*)', 'Bash(npx prettier --check:*)',
  'Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)', 'Bash(cargo test:*)', 'Bash(cargo build:*)',
  'Bash(cargo check:*)', 'Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)',
  'Bash(dotnet test:*)', 'Bash(dotnet build:*)', 'Bash(make:*)',
];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
// Claude must never read typical secret files, because everything it reads goes to Anthropic.
// This is a safety net, not a guarantee: secrets hidden in code or git history are not caught.
const SECRET_DENY = [
  'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/*.pfx)', 'Read(**/*.p12)',
  'Read(**/id_rsa*)', 'Read(**/secrets/**)', 'Read(**/credentials*)', 'Read(**/*.sqlite)', 'Read(**/*.sqlite3)',
  'Read(**/*.db)', 'Read(**/config.local.*)', 'Read(**/*.local.json)', 'Read(**/service-account*.json)',
];

const L = {
  de: {
    ok: 'Urteil: FREIGEGEBEN', block: 'Urteil: BLOCKIEREN (Handlungsbedarf)', summary: 'Zusammenfassung',
    findings: 'Befunde (nach Schwere)', none: 'Keine Befunde.', checks: 'Prüfungen', resolved: 'Frühere Befunde',
    next: 'Nächste Schritte', rec: 'Empfehlung', conf: 'Konfidenz', cost: 'Kosten',
    sev: { critical: 'KRITISCH', high: 'HOCH', medium: 'MITTEL', low: 'NIEDRIG' },
  },
  en: {
    ok: 'Verdict: APPROVED', block: 'Verdict: BLOCK (needs attention)', summary: 'Summary',
    findings: 'Findings (by severity)', none: 'No findings.', checks: 'Checks', resolved: 'Earlier findings',
    next: 'Next steps', rec: 'Recommendation', conf: 'Confidence', cost: 'Cost',
    sev: { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' },
  },
};

const USAGE = `claude-bridge <command> [options] [text]

Commands
  setup                          check Claude CLI, login and git
  review [focus]                 Claude reviews the change (read-only)
  adversarial-review [focus]     skeptical review of design and failure modes (read-only)
  test [scope]                   Claude builds, runs the tests and probes edge cases (no edits)
  verify                         check that the findings of the last review are fixed
  gate                           pre-ship verdict: first line ALLOW or BLOCK (exit 3 on BLOCK)
  task <text>                    delegate any job; read-only unless --write
  status | result [id] | cancel [id]   background jobs

Options
  --background        run detached, then use status/result      --wait   run in foreground (default)
  --scope auto|working-tree|branch   --base <ref>              --focus <text>
  --model <alias|name>   --effort low|medium|high|xhigh|max     --budget <usd>   (default 2)
  --resume | --fresh     continue or restart the last Claude session
  --write             task only: allow edits (a rollback patch is saved first)
  --allow <tool>      extra allowed tool pattern, e.g. "Bash(make lint:*)" (repeatable)
  --lang de|en        language of Claude's prose (default de)   --dry-run   show the call, run nothing`;

// ---------- small helpers ----------
const die = (msg, code = 2) => ({ text: msg, code });
const clean = (s) => String(s ?? '').replace(new RegExp(`[ \\t]*${LONG_DASH}[ \\t]*`, 'g'), ' - ');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const raw = r.stdout || '';
  return { ok: r.status === 0, raw, out: raw.trim(), err: (r.stderr || '').trim() };
}
const repoRoot = (cwd) => { const r = git(['rev-parse', '--show-toplevel'], cwd); return r.ok ? path.resolve(r.out) : null; };

function stateDir(root) {
  const base = process.env.CLAUDE_CONTROLLER_HOME || path.join(os.homedir(), '.claude-controller');
  const key = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12);
  const d = path.join(base, key);
  fs.mkdirSync(path.join(d, 'jobs'), { recursive: true });
  return d;
}

function parseArgs(argv) {
  const BOOL = new Set(['wait', 'background', 'resume', 'fresh', 'write', 'dry-run']);
  const VAL = new Set(['base', 'scope', 'model', 'effort', 'budget', 'focus', 'lang', 'allow']);
  const o = { allow: [], text: [], cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL.has(k)) o[k] = true;
      else if (VAL.has(k)) {
        const v = argv[++i];
        if (v === undefined) return { error: `--${k} needs a value` };
        if (k === 'allow') o.allow.push(v); else o[k] = v;
      } else return { error: `Unknown option --${k}` };
    } else if (!o.cmd) o.cmd = a;
    else o.text.push(a);
  }
  o.textStr = o.text.join(' ').trim();
  return o;
}

function resolveClaude() {
  const env = process.env.CLAUDE_CONTROLLER_CLAUDE_BIN;
  if (env) return /\.(mjs|cjs|js)$/i.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] };
  if (!IS_WIN) return { cmd: 'claude', pre: [] };
  const cands = [];
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    cands.push(...out.split(/\r?\n/).filter(Boolean));
  } catch { /* not on PATH */ }
  // npm installs put the real binary under node_modules, next to a claude.cmd shim that spawn() cannot start safely
  const npmBin = (dir) => path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const c of [...cands]) if (/\.cmd$/i.test(c)) cands.push(npmBin(path.dirname(c)));
  if (process.env.APPDATA) cands.push(npmBin(path.join(process.env.APPDATA, 'npm')), path.join(process.env.APPDATA, 'npm', 'claude.exe'));
  cands.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  const exe = cands.find((c) => /\.exe$/i.test(c) && fs.existsSync(c));
  return exe ? { cmd: exe, pre: [] } : null;
}

function run(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input === undefined ? '' : input);
  });
}

// ---------- git targets ----------
function resolveTarget(o, cwd) {
  const root = repoRoot(cwd);
  if (!root) return { error: 'No git repository found. This command needs git.' };
  const safeRef = (r) => /^[\w./@^~-]+$/.test(r) && !r.startsWith('-');
  const status = git(['status', '--short', '--untracked-files=all'], root).out;
  let scope = o.scope || 'auto';
  if (scope === 'auto') scope = status ? 'working-tree' : 'branch';
  if (scope === 'working-tree') {
    if (!status) return { root, empty: true };
    const stat = git(['diff', 'HEAD', '--shortstat'], root).out || '(only untracked files)';
    return {
      root, label: 'Uncommitted changes (working tree vs HEAD, including untracked files)',
      detail: `${stat}\n${status.split(/\r?\n/).slice(0, 200).join('\n')}`,
      how: 'git status --short --untracked-files=all ; git diff HEAD ; read untracked files directly',
    };
  }
  if (scope === 'branch') {
    let base = o.base;
    if (base && !safeRef(base)) return { error: `Invalid --base value: ${base}` };
    base = base || ['main', 'master', 'develop'].find((b) => git(['rev-parse', '--verify', '--quiet', b], root).ok);
    if (!base) return { error: 'No base branch found. Pass --base <ref>.' };
    const stat = git(['diff', `${base}...HEAD`, '--shortstat'], root).out;
    if (!stat) return { root, empty: true };
    const files = git(['diff', `${base}...HEAD`, '--name-status'], root).out.split(/\r?\n/).slice(0, 200).join('\n');
    return { root, label: `Branch changes (${base}...HEAD)`, detail: `${stat}\n${files}`, how: `git diff ${base}...HEAD ; git log ${base}..HEAD` };
  }
  return { error: `Unknown --scope ${scope}` };
}

function backup(root, sd) {
  const head = git(['rev-parse', 'HEAD'], root);
  if (!head.ok) return null;
  const dir = path.join(sd, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const patch = path.join(dir, `${ts}.patch`);
  fs.writeFileSync(patch, git(['diff', 'HEAD', '--binary'], root).raw);
  writeJson(path.join(dir, `${ts}.json`), { base: head.out, untracked: git(['ls-files', '--others', '--exclude-standard'], root).out.split(/\r?\n/).filter(Boolean) });
  return patch;
}

// ---------- rendering ----------
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function renderStructured(data, lang) {
  const t = L[lang] || L.de;
  const out = [];
  out.push(data.verdict === 'approve' ? t.ok : t.block);
  if (data.summary) out.push(`${t.summary}: ${data.summary}`);
  const list = [...(data.findings || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  out.push('', `${t.findings}:`);
  if (!list.length) out.push(`  ${t.none}`);
  list.forEach((f, i) => {
    const loc = f.file ? ` (${f.file}${f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ''}` : ''}${f.confidence != null ? `, ${t.conf} ${f.confidence}` : ''})` : '';
    out.push(`${i + 1}. [F${i + 1}] [${t.sev[f.severity] || f.severity}] ${f.title}${loc}`);
    out.push(`   ${f.body}`);
    if (f.recommendation) out.push(`   ${t.rec}: ${f.recommendation}`);
  });
  if (data.checks?.length) {
    out.push('', `${t.checks}:`);
    data.checks.forEach((c) => out.push(`  - ${c.name}: ${String(c.result).toUpperCase()}${c.command ? ` (${c.command})` : ''}${c.detail ? ` ${c.detail}` : ''}`));
  }
  if (data.resolved?.length) {
    out.push('', `${t.resolved}:`);
    data.resolved.forEach((r) => out.push(`  - ${r.id}: ${r.status}. ${r.evidence}`));
  }
  if (data.next_steps?.length) {
    out.push('', `${t.next}:`);
    data.next_steps.forEach((s) => out.push(`  - ${s}`));
  }
  return { text: out.join('\n'), sorted: list };
}

function parseClaudeJson(stdout) {
  let j;
  try { j = JSON.parse(stdout.trim()); } catch { return null; }
  if (Array.isArray(j)) j = [...j].reverse().find((x) => x && x.type === 'result') || j[j.length - 1];
  return j;
}

// ---------- commands ----------
async function setup() {
  const bin = resolveClaude();
  if (!bin) return die('Claude CLI not found. Install it (npm install -g @anthropic-ai/claude-code) or set CLAUDE_CONTROLLER_CLAUDE_BIN to the full path of claude.exe.');
  const lines = []; let code = 0;
  const v = await run(bin.cmd, [...bin.pre, '--version']);
  lines.push(`Claude CLI: ${v.out.trim() || 'version unknown'}${v.code !== 0 ? ' (call failed)' : ''}`);
  const a = await run(bin.cmd, [...bin.pre, 'auth', 'status']);
  let logged = false, method = 'none';
  try { const j = JSON.parse(a.out); logged = !!j.loggedIn; method = j.authMethod || method; } catch { /* ignore */ }
  const key = !!process.env.ANTHROPIC_API_KEY;
  if (logged || key) lines.push(`Login: ok (${key ? 'ANTHROPIC_API_KEY' : method})`);
  else { lines.push('Login: NOT signed in. The user must run `claude auth login` once in a terminal (or set ANTHROPIC_API_KEY). Codex cannot do this for them.'); code = 2; }
  const g = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  lines.push(`git: ${g.status === 0 ? g.stdout.trim() : 'MISSING (review, verify and gate need git)'}`);
  return { text: lines.join('\n'), code };
}

async function control(o, cwd) {
  if (process.env.CLAUDE_CONTROLLER_ACTIVE) return die('Refusing to start Claude from inside a Claude controller run (loop guard).');
  const kind = o.cmd;
  const root = repoRoot(cwd) || cwd;
  const sd = stateDir(root);
  const stFile = path.join(sd, 'state.json');
  const st = readJson(stFile, {});
  const lang = o.lang || process.env.CLAUDE_CONTROLLER_LANG || 'de';

  let target = null, previous = null;
  if (['review', 'adversarial-review', 'verify', 'gate'].includes(kind)) {
    target = resolveTarget(o, cwd);
    if (target.error) return die(target.error);
    if (target.empty) return { text: lang === 'de' ? 'Nichts zu prüfen: keine Änderungen im gewählten Bereich.' : 'Nothing to review: no changes in the selected scope.', code: 0 };
  }
  if (kind === 'verify') {
    previous = (st.lastReview?.findings || []).map((f, i) => ({ id: `F${i + 1}`, severity: f.severity, title: f.title, file: f.file, line_start: f.line_start, body: f.body }));
    if (!previous.length) return die('No earlier findings to verify. Run review or adversarial-review first.');
  }
  if (kind === 'task' && !o.textStr) return die('task needs a description of the job.');

  const write = kind === 'task' && !!o.write;
  const prompt = buildPrompt(kind, { target, focus: o.focus || o.textStr, lang, previous, task: o.textStr, write });

  const bin = resolveClaude();
  if (!bin && !o['dry-run']) return die('Claude CLI not found. Run `setup` for help.');
  const model = o.model || DEFAULT_MODEL[kind];
  const budget = String(o.budget || process.env.CLAUDE_CONTROLLER_BUDGET || '2');
  const allowed = [...READ_TOOLS, ...(kind === 'test' || write ? TEST_TOOLS : []), ...(write ? WRITE_TOOLS : []), ...o.allow];
  const args = [...(bin ? bin.pre : []), '-p', '--output-format', 'json', '--model', model,
    '--permission-mode', write ? 'acceptEdits' : 'dontAsk', '--max-budget-usd', budget, '--allowedTools', allowed.join(',')];
  if (o.effort) args.push('--effort', o.effort);
  const denied = [...SECRET_DENY, ...(write ? [] : ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])];
  args.push('--disallowedTools', denied.join(','));
  if (STRUCTURED.has(kind)) args.push('--json-schema', JSON.stringify(SCHEMA));
  if (o.resume && !o.fresh && st.lastSession) args.push('--resume', st.lastSession);

  if (o['dry-run']) return { text: JSON.stringify({ bin: bin?.cmd, args, cwd: root, prompt }, null, 2), code: 0 };

  let note = '';
  if (write) { const p = backup(root, sd); note = p ? `Rollback patch saved: ${p}\n` : 'No git HEAD: no rollback patch could be saved.\n'; }

  const r = await run(bin.cmd, args, { input: prompt, cwd: root, env: { CLAUDE_CONTROLLER_ACTIVE: '1' } });
  if (r.code === -1) return die(`Could not start Claude: ${r.err}`, 1);
  const j = parseClaudeJson(r.out);
  if (!j) return die(`Claude returned no readable JSON.\n${clean((r.err || r.out).split(/\r?\n/).slice(-8).join('\n'))}`, 1);

  const t = L[lang] || L.de;
  const meta = `-- Claude ${model} | ${j.num_turns ?? '?'} turns | ${t.cost}: $${Number(j.total_cost_usd || 0).toFixed(2)} | session ${j.session_id || '?'}`;
  if (j.session_id) st.lastSession = j.session_id;

  if (j.is_error || (j.subtype && j.subtype !== 'success')) {
    writeJson(stFile, st);
    const why = j.subtype === 'error_max_budget_usd' ? `Budget of $${budget} reached before the job finished. Raise it with --budget.` : clean(j.result || r.err || j.subtype);
    return die(`Claude run failed (${j.subtype || 'error'}): ${why}\n${meta}`, 1);
  }

  let text, code = 0;
  if (STRUCTURED.has(kind)) {
    let data = j.structured_output;
    if (!data) { try { data = JSON.parse(j.result); } catch { /* fall through */ } }
    if (data && typeof data === 'object') {
      const rendered = renderStructured(data, lang);
      text = clean(rendered.text);
      // a clean test run must not wipe the findings of an earlier review
      if (kind !== 'test' || rendered.sorted.length) st.lastReview = { at: new Date().toISOString(), kind, findings: rendered.sorted };
    } else text = clean(j.result || '(empty answer)');
  } else {
    text = clean(j.result || '(empty answer)');
    if (kind === 'gate' && /^\s*BLOCK/i.test(text)) code = 3;
  }
  writeJson(stFile, st);
  return { text: `${note}${text}\n\n${meta}`, code };
}

// ---------- background jobs ----------
function startJob(argv, cwd, root) {
  const sd = stateDir(root);
  const id = crypto.randomBytes(3).toString('hex');
  const args = argv.filter((a) => a !== '--background');
  writeJson(path.join(sd, 'jobs', `${id}.json`), { id, cmd: args[0], argv: args, cwd, state: 'queued', started: new Date().toISOString() });
  const child = spawn(process.execPath, [SELF, '__run', id], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { text: `Job ${id} started in the background (${args[0]}). Check: status | result ${id} | cancel ${id}`, code: 0 };
}

async function runJob(id, cwd) {
  const root = repoRoot(cwd) || cwd;
  const sd = stateDir(root);
  const f = path.join(sd, 'jobs', `${id}.json`);
  const job = readJson(f, null);
  if (!job) return;
  job.state = 'running'; job.pid = process.pid; writeJson(f, job);
  const o = parseArgs(job.argv);
  const res = o.error ? die(o.error) : await dispatch(o, job.cwd, job.argv);
  fs.writeFileSync(path.join(sd, 'jobs', `${id}.out.txt`), res.text + '\n');
  job.state = res.code === 0 ? 'done' : 'failed'; job.exit = res.code; job.ended = new Date().toISOString();
  writeJson(f, job);
}

function jobList(sd) {
  return fs.readdirSync(path.join(sd, 'jobs')).filter((n) => /^[0-9a-f]+\.json$/.test(n))
    .map((n) => readJson(path.join(sd, 'jobs', n), null)).filter(Boolean).sort((a, b) => a.started.localeCompare(b.started));
}

function jobCommands(o, cwd) {
  const sd = stateDir(repoRoot(cwd) || cwd);
  const jobs = jobList(sd);
  if (o.cmd === 'status') {
    if (!jobs.length) return { text: 'No jobs.', code: 0 };
    return { text: jobs.map((j) => `${j.id}  ${j.cmd}  ${j.state}  ${j.started}`).join('\n'), code: 0 };
  }
  const id = o.textStr || (o.cmd === 'cancel' ? jobs.filter((j) => j.state === 'running' || j.state === 'queued').pop()?.id : jobs.pop()?.id);
  const job = jobs.find((j) => j.id === id);
  if (!job) return die('No matching job.');
  if (o.cmd === 'result') {
    if (job.state === 'running' || job.state === 'queued') return { text: `Job ${job.id} is still ${job.state}.`, code: 0 };
    const p = path.join(sd, 'jobs', `${job.id}.out.txt`);
    return { text: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(no output stored)', code: job.exit || 0 };
  }
  if (job.pid) {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(job.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-job.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
  job.state = 'cancelled'; writeJson(path.join(sd, 'jobs', `${job.id}.json`), job);
  return { text: `Job ${job.id} cancelled.`, code: 0 };
}

async function dispatch(o, cwd, rawArgv) {
  switch (o.cmd) {
    case 'setup': return setup();
    case 'status': case 'result': case 'cancel': return jobCommands(o, cwd);
    case 'review': case 'adversarial-review': case 'test': case 'verify': case 'gate': case 'task':
      if (o.background && !o['dry-run']) return startJob(rawArgv, cwd, repoRoot(cwd) || cwd);
      return control(o, cwd);
    default: return { text: USAGE, code: o.cmd ? 2 : 0 };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '__run') { await runJob(argv[1], process.cwd()); return; }
  const o = parseArgs(argv);
  const res = o.error ? die(`${o.error}\n\n${USAGE}`) : await dispatch(o, process.cwd(), argv);
  process.stdout.write(res.text + '\n');
  process.exitCode = res.code;
}

main().catch((e) => { process.stderr.write(`claude-bridge error: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
