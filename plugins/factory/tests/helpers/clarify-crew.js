'use strict';
// A scripted clarify crew for the workflow harness (tests/helpers/workflow-harness.js): the
// agents the real fanout-judge workflow starts in a clarify round, playing the J-0002 pattern
// on a job, round by round.
//
//   fresh job, round 1  the intent gate is clear; the judge asks about pruning and the device
//                       roles, and raises the NX-OS command syntax as "new" (an implementation
//                       detail: deferred to design, not asked)
//   fresh job, round 2  the contract editor applies the answer and the accepted default; the
//                       judge paraphrases the NX-OS command and the prune question again (both
//                       folded as notes, nothing asked); God Eye's first look has one pointed
//                       blocker (AC-2), the editor revises, God Eye's second look has only an
//                       unpointed minor item: approve with notes → H1
//   opts.stall          every round says nothing new and God Eye keeps one unfixable major item
//   opts.migrated       the J-0002 job after migration: the judge re-raises the NX-OS command,
//                       God Eye names the settled issue and a minor item (notes only)
//
// crew(root, J, opts) → { agent(prompt, opts), calls } for H.run(workflow, brief, agent).

const fs = require('fs');
const path = require('path');

const NXOS = 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?';

// The run file a pointer prompt names, then whatever the workflow appended after it.
function textOf(prompt) {
  const line = String(prompt).split('\n').find((l) => l.trim().startsWith('/') && l.trim().endsWith('.md'));
  const file = line && fs.existsSync(line.trim()) ? fs.readFileSync(line.trim(), 'utf8') : '';
  return `${file}\n${prompt}`;
}

function crew(root, J, opts = {}) {
  const contractFile = path.join(root, '.factory', 'jobs', J, 'contract.md');
  const n = {};
  const calls = [];
  const base = { intent_confirmed: true, restatement: { problem: 'trunk VLANs drift from Nautobot', who: 'network automation team', outcome: 'trunks carry exactly the VLANs Nautobot lists', success: 'zero drift for a week' } };
  const checklist = (acs = true) => ({ intent_clear: true, scope_bounded: true, acs_testable: acs, no_open_blockers: true, constraints_consistent: true });
  const agent = (prompt, o) => {
    const role = o.agentType.replace(/^factory:/, '');
    const k = (n[role] = (n[role] || 0) + 1) - 1;
    const text = textOf(prompt);
    calls.push({ role, label: o.label, k });
    switch (role) {
      case 'intent-analyst':
        if (/^analyst · intent/.test(o.label)) return { focus: 'intent', questions: [], restatement: { problem: 'trunk VLANs drift', who: 'network automation', outcome: 'trunks match Nautobot', success: 'zero drift for a week' }, assumptions: [] };
        return { focus: o.label.replace(/^analyst · /, ''), questions: [], assumptions: [] };
      case 'judge': {
        if (opts.stall) return { questions: [], held: [], dismissed: [] };
        if (opts.migrated) {
          return { questions: [{ question: 'What exact command form does NX-OS use for the trunk allowed VLAN list?', category: 'constraint', why: 'A wrong command breaks trunks.', default: 'switchport trunk allowed vlan', same_as: 'new', subject: 'nxos.trunk-command' }], held: [], dismissed: [] };
        }
        const round = (text.match(/Mode: clarify, round (\d+)/) || [])[1];
        if (round === '1') {
          return {
            questions: [
              { question: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', category: 'scope', why: 'Pruning can cut traffic.', default: 'Your call: prune them', options: ['Yes, prune them', 'No, only add'], same_as: 'new', subject: 'sync.prune' },
              { question: 'Which device roles are in scope for the sync (leaf, spine, border)?', category: 'scope', why: 'The scope of the change.', default: 'leaf only', same_as: 'new', subject: 'sync.device-roles' },
              // the J-0002 pattern: the NX-OS command, an implementation detail, as a question
              { question: 'What is the exact NX-OS syntax for switchport trunk allowed vlan?', category: 'constraint', why: 'A wrong command breaks trunks.', default: 'switchport trunk allowed vlan <list>', same_as: 'new', subject: 'nxos.switchport-syntax' },
            ],
            held: [],
            dismissed: [],
          };
        }
        // later rounds: the same two subjects again, in other words, as "new"
        return {
          questions: [
            { question: 'Which command does NX-OS accept to set allowed VLANs on trunk ports?', category: 'constraint', why: 'w', default: 'switchport trunk allowed vlan', same_as: 'new', subject: 'nxos.trunk-command' },
            { question: 'Should VLANs missing from Nautobot be pruned from the switch trunks?', category: 'scope', why: 'w', default: 'Your call: prune them', same_as: 'new', subject: 'sync.prune' },
          ],
          held: [],
          dismissed: [],
        };
      }
      case 'contract-editor': {
        const cur = (prompt.match(/----- BEGIN CONTRACT -----\n([\s\S]*?)\n----- END CONTRACT -----/) || [])[1] || fs.readFileSync(contractFile, 'utf8');
        const todo = JSON.parse((prompt.match(/CHANGES TO APPLY:\n([\s\S]*?)(?:\n\nCURRENT CONTRACT|\n\nCLARIFY LEDGER|$)/) || [])[1] || '[]');
        let next = cur;
        const applied = [];
        const settled = todo.filter((t) => t.from === 'ledger');
        if (settled.length) {
          next = next.replace('## Constraints\n', `## Constraints\n${settled.map((t) => `- ${t.issue.replace(/\?$/, '')}: ${t.settled}`).join('\n')}\n`);
          for (const t of settled) applied.push({ ref: t.ref, section: 'Constraints', change: 'stated the settled answer' });
        }
        if (todo.some((t) => t.from === 'god-eye' && t.ref === 'AC-2')) {
          next = next.replace(/- AC-2: [^\n]*/, '- AC-2: a dry run lists each VLAN it would add or remove per interface, and applies nothing (evidence: test)');
          applied.push({ ref: 'AC-2', section: 'Acceptance criteria', change: 'the dry run output is named' });
        }
        return { contract: next, applied, skipped: [], removed: [] };
      }
      case 'god-eye': {
        if (opts.stall) return { ...base, verdict: 'revise', checklist: checklist(), items: [{ issue: 'The log format is not named', severity: 'major', ref: 'Constraints', suggestion: 'name it' }] };
        if (opts.migrated) {
          return { ...base, verdict: 'revise', checklist: checklist(), items: [{ issue: 'The exact NX-OS command for the allowed VLAN list is still not stated', severity: 'major', ref: 'U-3', same_as: 'U-3', subject: 'nxos.command' }, { issue: 'The Goal could name the drift report', severity: 'minor', suggestion: 'mention it' }] };
        }
        if (/REVISION: the contract was revised/.test(prompt)) {
          // the second look: only an unpointed minor item left (nothing actionable)
          return { ...base, verdict: 'revise', checklist: checklist(), items: [{ issue: 'The Goal could name the drift report', severity: 'minor', suggestion: 'mention it' }] };
        }
        return {
          ...base,
          verdict: 'revise',
          checklist: checklist(false),
          items: [
            { issue: 'AC-2 does not say what a dry run lists, so no test can check it', severity: 'blocker', suggestion: 'AC-2: a dry run lists each VLAN it would add or remove per interface (evidence: test)', ref: 'AC-2', same_as: 'new', subject: 'ac2.dry-run-output' },
            { issue: 'The exact NX-OS command for the allowed VLAN list is still not stated', severity: 'major', ref: 'Constraints', same_as: 'new', subject: 'nxos.switchport-syntax' },
          ],
        };
      }
      default:
        throw new Error(`clarify-crew: no script for ${role}`);
    }
  };
  return { agent, calls };
}

module.exports = { crew, textOf, NXOS };
