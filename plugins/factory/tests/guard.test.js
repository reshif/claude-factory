'use strict';
// Guard regressions (ported from copilot-factory's hook-blocks and terminal-emulator fixes):
// commands are read like a shell (hooks/shell.js), so a factory verb counts only where a
// command runs. Prose, patterns, commit messages, expansions, templates and briefed CLI calls
// are allowed; human-only verbs through variables, eval, xargs, heredocs, find -exec and
// terminal emulators are still denied; inline code may read the job in scope, nothing else
// under .factory/; every Bash deny quotes the command it saw.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const { checkBash, checkContent, checkReadTool, checkWrite, checkRead } = require('../hooks/guard-rules');
const policyMod = require('../cli/core/policy');

const B = path.join(F.PLUGIN, 'bin', 'factory');
const guard = (input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify(input), encoding: 'utf8' });
const reasonOf = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null);

test('guard regressions: prose, patterns, messages, expansions, templates and briefed CLI calls are not violations', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const pol = policyMod.load(root);
  const allowed = [
    // the word "factory" next to a human-only verb, in data
    'grep -rn "factory approve" docs/',
    "grep -rn 'factory approve' docs/",
    'git grep -n "factory approve"',
    'grep -rn -e "factory approve" -e "factory deny" .',
    'rg "factory resume" .',
    'rg factory resume .',
    'grep -rn factory\\ approve docs/',
    "echo 'Next: reply resume, or run factory resume'",
    'printf "%s\\n" "factory approve"',
    "git log --oneline --grep 'factory merged'",
    'gh pr create --title x --body "After CI, run factory approve to ship"',
    'gh pr comment 3 --body "factory deny <reason> if it looks wrong"',
    'git commit -F - <<EOF\nfeat: factory confirm wording\nEOF',
    'cat > PR.md <<EOF\nAfter review run factory approve\nEOF',
    'echo "$HOME" && grep -n "factory" README.md | grep cancel',
    `node "${B}" record --file - <<EOF\n{"summary":"the factory deny path"}\nEOF`,
    'git commit -m "docs: explain factory approve" && git push origin main',
    `node "${B}" park --reason "factory resume later, after legal"`,
    // commands that start with an expansion
    '$HOME/.local/bin/ruff check .',
    '"$VIRTUAL_ENV/bin/python" -m pytest',
    '$PWD/scripts/x.sh',
    // interpreters next to factory paths in other commands
    'npm run lint && node ./scripts/check.js && ls .factory/',
    'git add -A && git commit -m "chore: ignore .factory/log" && python3 -V',
    // git objects that are not secrets
    'git show HEAD:.env.example',
    'git show HEAD~1 -- .env.example',
    'git show HEAD:docs/credentials-setup.md',
    'git show HEAD:.env.sample && git show HEAD:config/.env.dist',
    // flags that only look like -n / interactive shells
    "git show --stat HEAD -n 1 --format='commit %H'",
    'git commit -m wip; npm test -- -n 5',
    'git log -n 3 --format=%s | grep commit',
    'bash --version',
    'bash -c "npm test"',
    'bash scripts/build.sh',
    'echo ls | sh',
    // redirects and templates
    'ls .factory/ 2>/dev/null; echo done >&2',
    'cp .env.example .env.sample',
    'cat .env.example .env.template',
    // what briefs ask agents to run: the CLI by its absolute path, on job files (a space too)
    `node "${B}" --root "${root}" doc check ${path.join(root, '.factory', 'jobs', J, 'adr-0001.md')} --job ${J}`,
    `node "/c/Users/John Smith/.claude/plugins/factory/bin/factory" --root "${root}" doc check "${path.join(root, '.factory', 'jobs', J, 'adr-0001 with space.md')}" --job ${J}`,
    `grep -rn "factory resume" ${path.join(root, '.factory', 'jobs', J, 'contract.md')}`,
    `node "${B}" lessons add --job ${J} --text "x" --scope src --why "the deny path crashed when $HOME was unset"`,
    `git -C .factory/worktrees/${J}-T1 commit -m "approve flow; resume after deny"`,
    `node ${B} job show | grep -i approve`,
    'grep -rn approve src/',
  ];
  for (const c of allowed) assert.equal(checkBash(root, c, pol), null, `should allow: ${c}`);
  // templates are not secrets (policy.secret_exempt), for writes and reads
  assert.equal(checkWrite(root, path.join(root, '.env.example'), pol), null);
  assert.equal(checkWrite(root, path.join(root, 'config', 'app.env.dist'), pol), null);
  assert.equal(checkRead(root, path.join(root, '.env.sample'), pol), null);
  assert.ok(pol.secret_exempt.includes('**/.env.example'));
  assert.equal(checkReadTool(root, 'Grep', { pattern: 'x', glob: '*.key*' }, null, root, pol), null, '*.key* also matches keyboard.js');
  // source that merely mentions factory paths in comments or prose
  assert.equal(checkContent('from os import path\n# see cli/core/ for details\n', '/r/src/importer.py'), null);
  assert.equal(checkContent("const {readFileSync}=require('fs');// parses .factory/log/events.jsonl format\n", '/r/test/log.test.js'), null);
  assert.equal(checkContent("// reads .factory/current\nconst x = require('./x');\nconst note = 'see .factory/jobs';\n", '/r/src/a.js'), null);
});

test('guard regressions: the real violations still deny, however they are typed', () => {
  const root = F.makeRepo();
  const pol = policyMod.load(root);
  const denied = [
    `node "${B}" approve`,
    `NODE_OPTIONS= node "${B}" --root . resume`,
    `env FOO=1 node ${B} cancel`,
    'sudo -u me factory abandon',
    'nice -n 5 factory waive AC1',
    'timeout 30 factory merged abc123',
    'exec factory confirm AC-1',
    'echo x; factory approve && echo y',
    'bash -c "factory approve"',
    `sh -lc 'node ${B} deny "no"'`,
    'echo "$(factory approve)"',
    'echo `factory resume`',
    'X=$(command -v factory); $X approve',
    '$(which factory) resume',
    `node "$(command -v factory)" approve H1`,
    `F=${B}; node $F approve`,
    `F="${B}"; node "$F" resume`,
    `echo approve | xargs node ${B}`,
    `eval "node ${B} app""rove"`,
    `alias f=${B}; f merged abc123`,
    `f() { node ${B} "$@"; }; f cancel`,
    `bash <<'EOF'\nnode ${B} approve\nEOF`,
    `cat <<'EOF' | sh\nnode ${B} waive AC1\nEOF`,
    `printf 'node ${B} approve' | bash`,
    `find . -name x -exec node ${B} approve \\;`,
    `node ${B} lessons accept L1`,
    'factory ci install',
    'git push --force-with-lease origin main',
    'git commit -anm "x"',
    'git config core.hooksPath /tmp/h',
    'ln -sf ../../x .git/hooks/pre-commit',
    'sed -i s/a/b/ .factory/jobs/J-0001/state.json',
    'cp x.json .factory/policy.json',
    'git show HEAD:.env.local',
    'git show HEAD -- config/.npmrc',
    'cat .env.production',
    "node -e \"require('fs').writeFileSync('.factory/jobs/J-0001/state.json','{}')\"",
    'cat ~/.config/software-factory/secret',
    'bash',
    'bash -i',
    'exec bash',
    'cp .env.example .env',
  ];
  for (const c of denied) assert.ok(checkBash(root, c, pol), `should deny: ${c}`);
  // prose next to a real call doesn't hide it
  for (const c of [`git commit -F - <<'EOF'\nnode ${B} approve\nEOF`]) assert.equal(checkBash(root, c, pol), null, `a commit message is data: ${c}`);
  assert.ok(checkReadTool(root, 'Grep', { pattern: 'x', glob: '.env*' }, null, root, pol));
  assert.ok(checkReadTool(root, 'Grep', { pattern: 'x', glob: '**/*.pem' }, null, root, pol));
  assert.ok(checkContent("const fs=require('fs');console.log(fs.readFileSync('.factory/current','utf8'))", '/r/scripts/status.js'));
});

test('guard: terminal emulators are allowed unless they wrap the factory CLI; the deny quotes the command', () => {
  const root = F.makeRepo();
  const bash = (command, extra = {}) => guard({ tool_name: 'Bash', tool_input: { command }, cwd: root, ...extra });
  const sub = { agent_id: 'a1', agent_type: 'factory:test-reviewer' };
  for (const c of ['empty', 'empty -f -i in -o out npm test', 'unbuffer npm test', 'script -q -c "npm test" log.txt', 'script -q /dev/null npm test']) {
    assert.equal(bash(c).stdout, '', `main session: ${c}`);
    assert.equal(bash(c, sub).stdout, '', `subagent: ${c}`);
  }
  for (const c of ['unbuffer factory approve', 'script -c "factory approve" /dev/null', 'expect -c "spawn factory approve; interact"', 'empty -f node /x/bin/factory resume']) {
    const r = bash(c);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', c);
    assert.match(reasonOf(r), /^\[factory guard\] .+ \(command: ".+"\)$/, 'the reason quotes the command it saw');
  }
});

test('guard: inline code may read the job in scope (its worktree, else the current job); other jobs, logs, writes and code loading stay denied', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const pol = policyMod.load(root);
  const as = (cmd, job = J) => checkBash(root, cmd, pol, { job });
  for (const c of [
    `python3 -c "import json; print(json.load(open('.factory/jobs/${J}/plan.json'))['tasks'])"`,
    `node -e "console.log(require('fs').readFileSync('.factory/jobs/${J}/contract.md', 'utf8'))"`,
    `python3 -c "import os; print(os.listdir('.factory/jobs/${J}'))"`,
    `python3 - <<'PY'\nprint(open('${root}/.factory/jobs/${J}/findings.md').read())\nPY`,
  ]) assert.equal(as(c), null, c);
  for (const c of [
    `python3 -c "print(open('.factory/jobs/J-0002/plan.json').read())"`,
    `python3 -c "print(open('.factory/jobs/${J}/../J-0002/plan.json').read())"`,
    `python3 -c "print(open('.factory/jobs/${J}2/plan.json').read())"`,
    `python3 -c "print(open('.factory/log/events.jsonl').read())"`,
    `python3 -c "open('.factory/jobs/${J}/plan.json', 'w').write('{}')"`,
    `node -e "require('fs').writeFileSync('.factory/jobs/${J}/state.json', '{}')"`,
    `node -e "require('${F.PLUGIN}/cli/core/job')"`,
    `python3 tools/read.py .factory/jobs/${J}/plan.json`,
  ]) assert.ok(as(c), `denied: ${c}`);
  // without a job in scope nothing is readable this way
  assert.ok(as(`python3 -c "print(open('.factory/jobs/${J}/plan.json').read())"`, null));
  // the hook: a subagent in a task worktree, and the main session on the current job
  const read = `python3 -c "print(open('${root}/.factory/jobs/${J}/plan.json').read())"`;
  const wt = path.join(root, '.factory', 'worktrees', `${J}-T1`);
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(guard({ tool_name: 'Bash', tool_input: { command: read }, cwd: wt, agent_id: 'a1', agent_type: 'factory:builder' }).stdout, '');
  assert.equal(guard({ tool_name: 'Bash', tool_input: { command: read }, cwd: root }).stdout, '', 'the current job');
  const other = `python3 -c "print(open('${root}/.factory/jobs/J-0042/plan.json').read())"`;
  assert.match(reasonOf(guard({ tool_name: 'Bash', tool_input: { command: other }, cwd: wt, agent_id: 'a1', agent_type: 'factory:builder' })), /Inline scripts may not reach into factory state/);
});
