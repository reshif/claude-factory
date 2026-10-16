'use strict';
// The 0.10.0 crew ("critics with evidence") for the workflow harness (claude-factory runs the
// workflows in Claude Code's Workflow tool; tests run the same scripts through
// tests/helpers/workflow-harness.js). It plays every role a medium or high job needs from ground
// to the plan gate:
//   - the interfaces researcher writes an API ledger from the fetched dependency source (its first
//     quote is at the wrong line, so factory record rejects it and asks once more);
//   - the architect's first design relies on a library flag the way it reads, not the way the
//     pinned source behaves (SKIP_UNMATCHED_DST "so stale VLANs are deleted"); its revise follows
//     the critic's evidence;
//   - the API-conformance critic reads the fetched source and objects with file:line;
//   - the finding verifier confirms what the source shows;
//   - the planner's first plan has a verify command that cannot run (a binary nobody installs),
//     fixed once the CLI's plan probe says so (opts.plan "good" starts with one that runs).

const fs = require('fs');
const path = require('path');
const F = require('./fixture');

// The pinned library the tests fetch (served by archives.fakeIndex as a wheel).
const LIB = {
  'diffsync/__init__.py': 'from diffsync.enum import DiffSyncFlags\n\n\ndef sync_to(target, flags=DiffSyncFlags.NONE):\n    """Sync to target; objects missing from the source are deleted unless a SKIP flag says otherwise."""\n    return target\n',
  'diffsync/enum.py': [
    'import enum',
    '',
    '',
    'class DiffSyncFlags(enum.Flag):',
    '    NONE = 0',
    '    SKIP_UNMATCHED_DST = 0b10  # objects only in the target are kept: nothing is deleted',
    '',
  ].join('\n'),
};

// What an agent was given: its prompt and the brief file it points at.
function readText(prompt) {
  const files = String(prompt || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l));
  return `${files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')}\n${prompt || ''}`;
}

function adr(J, { threats, decision, usage }) {
  const text = F.adrText({ job: J, acs: ['AC-1'], threats, decision });
  return text.replace('## Consequences', `## External API usage\n| Symbol | How the design uses it | Ledger |\n|---|---|---|\n| ${usage} | L-1 |\n\n## Consequences`);
}

// crew(root, J, opts) → (prompt, opts) => reply, for workflow-harness.run.
function crew(root, J, o = {}) {
  const jd = path.join(root, '.factory', 'jobs', J);
  const lib = `.factory/deps/${J}/pypi/diffsync-2.0.1/diffsync/enum.py`;
  const seen = { 'option-generator': 0 };
  return (prompt, opts) => {
    const role = opts.agentType.replace(/^factory:/, '');
    const text = readText(prompt);
    switch (role) {
      case 'researcher': {
        if (!/Topic: \*\*interfaces\*\*/.test(text)) return { topic: (/Topic: \*\*([\w ]+)\*\*/.exec(text) || [])[1] || 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
        const again = /API ledger's second look/.test(text);
        return {
          topic: 'interfaces',
          claims: [{ claim: 'The sync uses diffsync 2.0.1 (requirements.txt)', source: 'requirements.txt:1' }],
          unknowns: [],
          ledger: [{ symbol: 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', file: lib, line: again ? 6 : 5, quote: 'SKIP_UNMATCHED_DST = 0b10', version: '2.0.1', behaviour: 'objects only in the target are kept: with this flag nothing is deleted' }],
        };
      }
      case 'option-generator':
        seen['option-generator'] += 1;
        return { title: `Option ${seen['option-generator']}`, summary: 'Sync VLANs with diffsync.', touches: ['src/add.js'], criteria: [{ id: 'AC-1', how: 'a test' }], pros: ['small'], cons: ['none'], risks: [] };
      case 'threat-modeler':
        fs.writeFileSync(path.join(jd, 'threat-model.md'), F.threatModelText({ job: J }));
        return { path: path.join(jd, 'threat-model.md'), threats: [{ id: 'TH-1', title: 't', mitigation: 'm' }], summary: 's' };
      case 'architect': {
        const file = path.join(jd, 'adr-001-sync.md');
        const threats = fs.existsSync(path.join(jd, 'threat-model.md')) ? ['TH-1'] : [];
        const revise = /api-conformance/.test(text) && /SKIP_UNMATCHED_DST/.test(text) && /Revise the design record/.test(text);
        fs.writeFileSync(file, revise
          ? adr(J, { threats, decision: 'We will call sync_to with DiffSyncFlags.NONE, so VLANs missing from the source are deleted (L-1: SKIP_UNMATCHED_DST would keep them).', usage: 'diffsync.sync_to(target, flags=DiffSyncFlags.NONE) | deletes objects missing from the source; SKIP_UNMATCHED_DST deliberately not passed' })
          : adr(J, { threats, decision: 'We will call sync_to with SKIP_UNMATCHED_DST so stale VLANs are deleted.', usage: 'diffsync.sync_to(target, flags=SKIP_UNMATCHED_DST) | deletes stale objects in the target' }));
        const check = F.cli(root, ['doc', 'check', file, '--job', J]);
        if (!check.ok) throw new Error(`doc check failed: ${JSON.stringify(check)}`);
        return { kind: 'adr', paths: [file], summary: revise ? 'Sync without SKIP_UNMATCHED_DST.' : 'Sync with SKIP_UNMATCHED_DST.', rejected: [] };
      }
      case 'api-conformance': {
        const design = fs.readFileSync(path.join(jd, 'adr-001-sync.md'), 'utf8');
        const src = fs.readFileSync(path.join(root, lib), 'utf8').split('\n');
        const line = src.findIndex((l) => l.includes('SKIP_UNMATCHED_DST =')) + 1;
        if (/flags=SKIP_UNMATCHED_DST/.test(design)) {
          return { verdict: 'revise', items: [{ symbol: 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', issue: 'ADR "Decision" passes SKIP_UNMATCHED_DST so stale VLANs are deleted; the pinned source keeps objects only in the target with that flag, so nothing is deleted.', severity: 'blocker', evidence: { kind: 'source', ref: `${lib}:${line}`, quote: 'SKIP_UNMATCHED_DST = 0b10' }, suggestion: 'Do not pass SKIP_UNMATCHED_DST.' }] };
        }
        return { verdict: 'approve', items: [] };
      }
      case 'god-eye':
        if (/Focus: \*\*plan\*\*/.test(text)) return { verdict: 'approve', items: [] };
        if (/Focus: \*\*diagnosis\*\*/.test(text)) return { cause: 'c', needs_user: false, approach: 'a', question: '', options: [], recommendation: '' };
        return { verdict: 'approve', items: [] };
      case 'finding-verifier': {
        const m = /"id": "([^"]+)"/.exec(text);
        return { finding_id: m ? m[1] : 'x', status: 'confirmed', evidence: [`${lib}:6 reads "SKIP_UNMATCHED_DST = 0b10  # objects only in the target are kept"`], reason: 'The source keeps target-only objects under that flag.' };
      }
      case 'planner': {
        const file = path.join(jd, 'plan.json');
        const fixed = o.plan === 'good' || /plan probe found these problems/.test(text);
        const cmd = fixed ? 'node tests/add.test.js' : 'vlan-sync-check --strict && node tests/add.test.js';
        fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'T1', objective: 'Sync without SKIP_UNMATCHED_DST (ADR 001)', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd, covers: ['AC-1'] }] }] }));
        // the build environment the plan runs in, proposed with it (nothing to download here)
        fs.writeFileSync(path.join(jd, 'environment.proposed.json'), JSON.stringify({ version: 1, name: 'node-test', setup: ['node --version'], env: { NODE_ENV: 'test' }, notes: 'Plain node; the tests need nothing installed.' }));
        const v = F.cli(root, ['plan', 'validate', '--job', J]);
        return { valid: Boolean(v.valid), errors: v.errors || [], path: file, summary: 'one task' };
      }
      default:
        throw new Error(`evidence-crew: no script for ${role}`);
    }
  };
}

module.exports = { LIB, crew, readText };
