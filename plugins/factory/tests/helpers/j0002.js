'use strict';
// A J-0002-shaped job in this factory's pre-v2 clarify format, for the clarify v2 migration
// and convergence tests. The real job (copilot-factory 0.4.x): Nautobot interface VLAN sync,
// standard@medium, 9 clarify rounds, parked on the round cap, the NX-OS command asked again and
// again in other words, free-form answers that settled nothing, implementation details asked as
// if they were intent.
//
// This factory's v1 clarify kept no issue record: the questions are in the sealed state.json
// (question_log: Q-n, round, category, question, default; asked_questions) and the answers in
// answers.json (by Q-n, or free-form by question text). build(root) writes, through the
// factory's own sealed writers:
//   jobs/J-0002/state.json     parked from clarify after 9 rounds, 18 questions logged, policy
//                              snapshot without clarify_no_progress_rounds (max_intent_rounds 4)
//   jobs/J-0002/answers.json   13 answers: by Q-n, by the exact question text, and free-form
//   jobs/J-0002/contract.md    the contract as clarify left it
// and no clarify-ledger.json.

const fs = require('fs');
const F = require('./fixture');

const CONTRACT = `# Nautobot interface VLAN sync

## Intent
- Problem: switch trunk VLANs drift from what Nautobot says the interfaces carry
- Who: the network automation team; asked by the DC operations lead
- Outcome: each managed trunk carries exactly the VLANs Nautobot lists for its interface
- Why now: two outages from stale trunk VLANs this quarter
- Success signal: the nightly drift report shows zero trunk VLAN mismatches for a week

## Goal
A sync job reads interface VLAN assignments from Nautobot and makes the NX-OS trunks match them.

## Non-goals
- Access-port VLANs
- Creating VLANs that do not exist on the switch

## Acceptance criteria
- AC-1: after a sync, each in-scope trunk's allowed VLANs equal Nautobot's tagged VLANs for that interface (evidence: test)
- AC-2: a dry run lists the changes without applying them (evidence: test)

## Constraints
- Runs from the existing automation container (Python 3.11)

## Allowed paths
- src/**
- tests/**

## Verify commands
- \`node tests/add.test.js\` (AC-1, AC-2)

## Assumptions
- The sync runs with a service account that may configure trunks
`;

// [Q-n, round, category, question, default]
const Q = [
  ['Q-1', 1, 'scope', 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', 'No: only add missing VLANs'],
  ['Q-2', 1, 'scope', 'Which device roles are in scope for the VLAN sync (leaf, spine, border)?', 'None given: answer needed'],
  ['Q-3', 1, 'constraint', 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?', 'switchport trunk allowed vlan <list>'],
  ['Q-4', 2, 'scope', 'Should the sync run nightly or on every Nautobot change?', 'Your call'],
  ['Q-5', 2, 'acceptance', 'Is a dry-run mode required before the first live run?', 'Yes'],
  ['Q-6', 3, 'constraint', 'What is the exact NX-OS syntax for switchport trunk allowed vlan?', 'switchport trunk allowed vlan <list>'],
  ['Q-7', 3, 'scope', 'How should the sync handle an interface with no VLANs in Nautobot?', 'Skip it'],
  ['Q-8', 4, 'scope', 'Who approves the first production run?', 'None given: answer needed'],
  ['Q-9', 4, 'constraint', 'Which pynautobot API field holds the untagged VLAN of an interface (untagged_vlan or native_vlan)?', 'untagged_vlan'],
  ['Q-10', 5, 'constraint', 'Is there a maintenance window the sync must respect?', 'None given: answer needed'],
  ['Q-11', 5, 'constraint', 'Confirm the NX-OS command form for configuring trunk allowed VLANs', 'switchport trunk allowed vlan'],
  ['Q-12', 6, 'acceptance', 'Must the sync log every change for audit?', 'Yes'],
  ['Q-13', 6, 'constraint', 'What are the exact line ranges in sync/nxos.py that build the VLAN commands?', 'None given: answer needed'],
  ['Q-14', 7, 'scope', 'Should port-channel members be synced individually or through the port-channel?', 'Through the port-channel'],
  ['Q-15', 7, 'constraint', 'Which command does NX-OS accept to set allowed VLANs on trunk ports?', 'switchport trunk allowed vlan'],
  ['Q-16', 8, 'acceptance', 'Is rollback of a failed sync required?', 'None given: answer needed'],
  ['Q-17', 8, 'constraint', 'NX-OS: is the command switchport trunk allowed vlan or switchport allowed vlan?', 'switchport trunk allowed vlan'],
  ['Q-18', 9, 'constraint', 'Does the ntc-templates parser for show interface switchport return trunking_vlans as a list?', 'Yes'],
];

// 13 answers: by Q-n (factory answer --id), by the exact question text, and free-form
// (factory answer --question "…"), which v1 recorded and never matched to anything.
const ANSWERS = [
  { id: 'Q-1', question: Q[0][3], answer: 'Yes, prune them' },
  { id: 'Q-5', question: Q[4][3], answer: 'yes' },
  { id: 'Q-7', question: Q[6][3], answer: 'skip it and report' },
  { question: 'Who approves the first production run?', answer: 'the DC operations lead' },
  { id: 'Q-12', question: Q[11][3], answer: 'yes, to the change log' },
  { id: 'Q-14', question: Q[13][3], answer: 'through the port-channel' },
  // free-form: the chat agent retyped the question
  { question: 'Which device roles are in scope for the sync?', answer: 'leaf and border, not spine' },
  { question: 'Is there a maintenance window for the sync?', answer: 'nightly 01:00-03:00 only' },
  { question: 'Is rollback required when a sync fails?', answer: 'yes, restore the previous allowed list' },
  { question: 'Does NX-OS keep the allowed list on a port-channel flap?', answer: 'yes' },
  // the user corrected an earlier answer
  { id: 'Q-1', question: Q[0][3], answer: 'yes, prune them, but never VLAN 1' },
  { question: 'What colour should the dashboard be?', answer: 'blue' },
  { id: 'Q-16', question: Q[15][3], answer: 'yes' },
];

function build(root) {
  const job = require('../../cli/core/job');
  const { jobPaths } = require('../../cli/lib/paths');
  F.cli(root, ['job', 'new', '--title', 'Request intake', '--type', 'feature', '--risk', 'medium']);
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', 'medium']).job;
  const jp = jobPaths(root, J);
  fs.writeFileSync(jp.contract, CONTRACT);
  const state = job.load(root, J);
  // the pre-v2 policy snapshot: max_intent_rounds 4 (cap + 2 = 6), no clarify_no_progress_rounds
  state.policy.limits.max_intent_rounds = 4;
  delete state.policy.limits.clarify_no_progress_rounds;
  const log = Q.map(([id, round, category, question, def]) => ({ id, round, category, question, default: def }));
  Object.assign(state, {
    status: 'parked',
    park: { reason: 'Clarify is not converging (9 rounds).', at: '2026-10-12T10:00:00.000Z', from: 'clarify' },
    pending_gate: { id: 'P', hash: null, docs: [], at: '2026-10-12T10:00:00.000Z' },
    question_log: log,
    asked_questions: log.map((q) => q.question),
  });
  state.counters.clarify_rounds = 9;
  state.counters.intent_rounds = 0;
  job.save(root, state);
  fs.writeFileSync(jp.answers, JSON.stringify(ANSWERS.map((a, i) => ({ ...a, at: `2026-10-1${i < 6 ? 1 : 2}T0${i % 10}:30:00.000Z` })), null, 2));
  return J;
}

module.exports = { build, CONTRACT, Q, ANSWERS };
