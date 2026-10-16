'use strict';
// 0.15.1: the Node the hooks run under. Claude Code runs each hook command through a shell with
// the environment it was started with; hooks/lib.js uses ?. (and CLI modules the hooks load use
// ??), so a Node older than 14 (Ubuntu's apt nodejs 12.x) fails every hook with a SyntaxError and
// the guard allows everything. The launchers in hooks/hooks.json (both plugins) then print one
// line naming the too-old node instead of a stack trace, and factory doctor checks the Node the
// hooks would get. Claude Code treats a hook's exit code 2 as "block" and any other non-zero
// code as a non-blocking error it shows: the launchers never exit 2, and keep a failure visible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const INSPECTOR = path.resolve(F.PLUGIN, '..', 'factory-inspector');
const PLUGINS = [[F.PLUGIN, 'factory'], [INSPECTOR, 'factory-inspector']];
const hooksOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
const each = (dir) => Object.entries(hooksOf(dir)).flatMap(([ev, list]) => list.flatMap((m) => m.hooks.map((h) => ({ ev, h }))));
const run = (cmd, env, input = '{}') => spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8', env: { HOME: os.tmpdir(), ...env } });

function fakeNode(script) {
  const dir = require('./helpers/tmp').mkdtemp('fake-node-');
  fs.writeFileSync(path.join(dir, 'node'), script, { mode: 0o755 });
  return dir;
}

test('hooks.json launchers: node runs the script; a too-old, missing or failing node is one line on stderr, never exit 2 (block)', { skip: process.platform === 'win32' && 'POSIX shell launchers' }, () => {
  for (const [dir, name] of PLUGINS) {
    for (const { ev, h } of each(dir)) {
      assert.equal(h.type, 'command');
      assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.js" \|\| \{ c=\$\?; /, `${name} ${ev}: node first, nothing on the success path`);
      assert.ok(h.command.includes(`case "$V" in v[0-9].*|v1[0-3].*) echo "[${name}:`), `${name} ${ev}: names a node older than 14`);
      assert.doesNotMatch(h.command, /exit 2\b/, 'exit 2 would block the tool');
    }
    // a Node too old for the hooks' syntax: one line naming its version, no stack trace, exit 1 (non-blocking)
    const old = fakeNode('#!/bin/sh\nif [ "$1" = "-v" ]; then echo v12.22.9; exit 0; fi\ncat >/dev/null\necho "SyntaxError: Unexpected token ." >&2\nexit 1\n');
    for (const { ev, h } of each(dir)) {
      const r = run(h.command, { CLAUDE_PLUGIN_ROOT: dir, PATH: `${old}:/usr/bin:/bin` });
      assert.equal(r.status, 1, `${name} ${ev}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^\\[${name}:[\\w-]+\\] node v12\\.22\\.9 is too old for the ${name} hooks \\(they need Node 14 or newer\\): ${name} hooks are off`, 'm'), `${name} ${ev}`);
    }
    // a Node that starts but dies (OOM kill, a crash before the hook's own catch): "hook failed (exit N)"
    const dies = fakeNode('#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.1.0; exit 0; fi\ncat >/dev/null\nexit 137\n');
    const g = each(dir).find((x) => x.ev === 'PreToolUse');
    let r = run(g.h.command, { CLAUDE_PLUGIN_ROOT: dir, PATH: `${dies}:/usr/bin:/bin` });
    assert.deepEqual([r.status, r.stdout], [1, '']);
    assert.match(r.stderr, new RegExp(`^\\[${name}:guard\\] hook failed \\(exit 137\\)$`, 'm'));
    // no node at all
    r = run(g.h.command, { CLAUDE_PLUGIN_ROOT: dir, PATH: '/nonexistent' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`\\[${name}:guard\\] node is not on PATH; ${name} hooks are off`));
  }
  // the real node: the guard's decision passes through unchanged, exit 0
  const root = F.makeRepo();
  const guard = each(F.PLUGIN).find((x) => x.ev === 'PreToolUse').h.command;
  const r = run(guard, { CLAUDE_PLUGIN_ROOT: F.PLUGIN, PATH: process.env.PATH }, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'factory approve H1' }, cwd: root, hook_event_name: 'PreToolUse' }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /human-only action[\s\S]*it will ask them to type a code shown there/);
});

// The Node the hooks need: what their code uses (and the modules they load), the number the
// launchers check and factory doctor's check, kept in step.
test('hooks need Node 14 (?. and ??): nothing newer in their code; doctor checks the Node this PATH, a login shell and /usr/bin/node would give them', () => {
  const setup = require('../cli/core/setup');
  assert.equal(setup.HOOK_NODE_MIN, 14);
  const NEWER = [[/(\?\?=|\|\|=|&&=)/, 'logical assignment (15)'], [/\.replaceAll\(/, 'replaceAll (15)'], [/\.at\(-?\d/, '.at() (16.6)'], [/Object\.hasOwn\b/, 'Object.hasOwn (16.9)'], [/\bstructuredClone\(/, 'structuredClone (17)'], [/\.findLast(Index)?\(/, 'findLast (18)'], [/\.to(Sorted|Reversed|Spliced)\(/, 'toSorted (20)'], [/require\('node:/, 'node: imports (14.18/16)'], [/\bstatic\s*\{/, 'static blocks (16.11)']];
  const found = [];
  for (const [dir] of PLUGINS) {
    const seen = new Set();
    const queue = fs.readdirSync(path.join(dir, 'hooks')).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, 'hooks', f));
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\('(\.[^']+)'\)/g)) {
        const p = path.resolve(path.dirname(f), m[1]).replace(/(\.js)?$/, '.js');
        if (fs.existsSync(p)) queue.push(p);
      }
    }
    for (const f of seen) {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const [re, what] of NEWER) if (re.test(code)) found.push(`${path.relative(dir, f)}: ${what}`);
    }
  }
  assert.deepEqual(found, [], 'raise HOOK_NODE_MIN, the launchers and their message together');
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'lib.js'), 'utf8'), /\?\.[a-z]/, 'and 14 is needed: lib.js uses ?.');

  // doctor: stubbed shells
  const stub = (here, login, sys) => (file) => (file === 'sh' ? (here ? { status: 0, stdout: here } : { status: 127, stdout: '' }) : file === 'bash' ? (login ? { status: 0, stdout: login } : { error: new Error('ENOENT') }) : sys ? { status: 0, stdout: sys } : { error: new Error('ENOENT') });
  let c = setup.hookNodeChecks(stub('/usr/bin/node\nv12.22.9\n', '/usr/bin/node\nv12.22.9\n', 'v12.22.9\n'));
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['hooks node', false]], 'the same node everywhere: said once');
  assert.match(c[0].detail, /this PATH: \/usr\/bin\/node v12\.22\.9 is too old for the factory hooks \(they need Node 14\+/);
  c = setup.hookNodeChecks(stub('/home/u/.nvm/versions/node/v20.11.0/bin/node\nv20.11.0\n', '/home/u/.nvm/versions/node/v20.11.0/bin/node\nv20.11.0\n', 'v12.22.9\n'));
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['hooks node', true], ['hooks node (/usr/bin/node)', false]], 'nvm on this PATH, but an old system node a bare PATH would find');
  c = setup.hookNodeChecks(stub('/usr/local/bin/node\nv22.1.0\n', '/usr/bin/node\nv12.22.9\n', null));
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['hooks node', true], ['hooks node (login shell)', false]], 'a login shell that finds another, older node');
  c = setup.hookNodeChecks(stub(null, null, null));
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['hooks node', false]]);
  assert.match(c[0].detail, /no node on this PATH/);
  const d = F.cli(F.makeRepo(), ['doctor']);
  const hn = d.checks.find((x) => x.name === 'hooks node');
  assert.ok(hn && hn.ok && hn.level === 'ok', JSON.stringify(hn));
});
