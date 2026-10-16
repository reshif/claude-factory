'use strict';
// Drives one clarify v3 scenario end to end the way the main session does in Claude Code:
// `factory next`; when a stage runs, `factory wfargs clarify`, the real workflows/clarify.js
// under the workflow harness with the scripted crew (clarify3-crew.js) as its agents, then
// `factory record`; when clarify waits, the user's words go through the real UserPromptSubmit
// hook (F.say), and what the hook leaves alone the main session relays verbatim with
// `factory clarify reply`. Gate replies (approve, deny, proceed, resume) are the user's chat
// replies through the same hook. It records every user turn with the agent calls it cost, every
// screen and every H1 view.

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./fixture');
const H = require('./workflow-harness');
const crew = require('./clarify3-crew');
const { validate } = require('../../cli/lib/schema');

const WORKFLOW = path.join(__dirname, '..', '..', 'workflows', 'clarify.js');

function makeRepo(files) {
  const root = require('./tmp').mkdtemp('clarify3-');
  F.sh(root, 'git init -q -b main && git config user.email t@example.com && git config user.name Tester && git config commit.gpgsign false');
  for (const [rel, text] of Object.entries(files)) F.write(root, rel, text);
  F.sh(root, 'git add -A && git commit -qm init');
  const out = F.cli(root, ['init']);
  if (out.error) throw new Error(JSON.stringify(out));
  return root;
}

function mergePolicy(root, extra) {
  if (!extra) return;
  const pf = path.join(root, '.factory', 'policy.json');
  const cur = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : {};
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    return a;
  };
  fs.writeFileSync(pf, JSON.stringify(merge(cur, extra), null, 2));
}

// One clarify stage, as the clarify skill runs it: brief, Workflow tool, record.
async function runStage(root, J, crewEnv, calls) {
  const brief = F.cli(root, ['wfargs', 'clarify']);
  if (brief.error) throw new Error(`wfargs clarify: ${JSON.stringify(brief).slice(0, 600)}`);
  const { result } = await H.run(WORKFLOW, JSON.stringify(brief), async (prompt, opts) => {
    const role = opts.agentType.replace(/^factory:/, '');
    calls.push({ role, label: opts.label, model: opts.model || null });
    const r = crew({ role, prompt, env: { FACTORY_ROOT: root, FACTORY_JOB: J, CREW: crewEnv } });
    if (r && r.__none) return null;
    // the Workflow tool's StructuredOutput: an agent's reply always matches the schema it was given
    const errs = validate(opts.schema, r);
    if (errs.length) throw new Error(`${role} (${opts.label}) reply breaks its schema: ${errs.slice(0, 3).join('; ')}`);
    return r;
  });
  return F.record(root, result);
}

// The user says something: the reply hook first; what it leaves alone the main session records
// verbatim with factory clarify reply (or redirect).
function userSays(root, text, { redirect = false } = {}) {
  const h = F.say(root, text);
  if (h.status === 'applied') return { via: 'hook', message: h.text };
  if (h.status === 'refused') return { via: 'hook', refused: true, message: h.text };
  const r = F.cli(root, ['clarify', redirect ? 'redirect' : 'reply', text]);
  return { via: 'relay', message: r.message || r.error, code: r.code || null, __code: r.__code };
}

async function drive(scen, { log = () => {} } = {}) {
  // an existing repository (a job made by an earlier version, upgraded mid-clarify) or a new one
  const root = scen.existing ? scen.existing.root : makeRepo(scen.repo);
  mergePolicy(root, scen.policy);
  const crewEnv = JSON.stringify({ scenario: scen.crew, ...(scen.crewOpts || {}) });
  const cli = (args) => F.cli(root, args);
  let J;
  if (scen.existing) J = scen.existing.J;
  else {
    // the request is the user's message; intake files it with --request, word for word
    F.say(root, scen.request);
    const created = cli(['job', 'new', '--title', scen.title, '--type', scen.type || 'feature', '--risk', scen.risk || 'medium', '--request', scen.request]);
    if (!created.job) throw new Error(`job new failed: ${JSON.stringify(created)}`);
    J = created.job;
  }
  const JD = F.jobDir(root, J);
  if (scen.draft) fs.writeFileSync(path.join(JD, 'contract.md'), scen.draft);
  const calls = [];
  const status = () => cli(['clarify', 'status', '--json']);
  const rec = { root, J, JD, turns: [{ turn: 0, said: scen.request, at_stage: 'request', calls: [] }], screens: [], h1: [], runs: [], parks: [], replies: [], end: null };
  let mark = 0;
  const closeTurn = () => {
    rec.turns[rec.turns.length - 1].calls.push(...calls.slice(mark).map((c) => c.role));
    mark = calls.length;
  };
  const user = (stage, said) => {
    closeTurn();
    rec.turns.push({ turn: rec.turns.length, said, at_stage: stage, calls: [] });
  };
  let sheets = 0;
  let readbacks = 0;
  let redirects = 0;
  let gates = 0;
  for (let step = 0; step < (scen.maxSteps || 40); step++) {
    const n = cli(['next']);
    if (n.action === 'skill' && n.skill === 'clarify') {
      const c = n.clarify || {};
      if (c.error) throw new Error(`clarify: ${c.error}`);
      if (c.run) {
        const r = await runStage(root, J, crewEnv, calls);
        rec.runs.push({ stage: c.stage, status: r.status, code: r.code || null, message: r.message || r.error || null });
        log(`run ${c.stage}: ${r.status || r.code} ${String(r.message || r.error || '').slice(0, 160)}`);
        if (r.__code !== 0 && !r.status) throw new Error(`factory record failed: ${JSON.stringify(r).slice(0, 800)}`);
        continue;
      }
      if (c.waiting_for_user) {
        const view = status();
        rec.screens.push({ stage: c.stage, screen: c.screen });
        let said;
        if (c.stage === 'readback_wait') said = scen.readbackReply ? scen.readbackReply(++readbacks, c.screen, view) : 'ok';
        else if (c.stage === 'sheet_wait') said = scen.sheet(c.screen, view, ++sheets);
        else if (c.stage === 'redirect_wait') said = scen.redirectReply ? scen.redirectReply(++redirects, c.screen, view) : 'ok';
        else throw new Error(`unknown wait stage ${c.stage}`);
        user(c.stage, said);
        const r = userSays(root, said);
        rec.replies.push({ stage: c.stage, said, via: r.via });
        log(`you (${c.stage}): ${said} → ${r.via}: ${String(r.message).slice(0, 160)}`);
        if (r.refused || (r.via === 'relay' && r.__code !== 0)) throw new Error(`clarify reply refused: ${JSON.stringify(r).slice(0, 600)}`);
        continue;
      }
      throw new Error(`clarify neither runs nor waits: ${JSON.stringify(n).slice(0, 600)}`);
    }
    if (n.action === 'gate' && /H1/.test(n.step || '')) {
      gates += 1;
      const contract = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
      const view = status();
      const h1 = n.clarify_h1 || view.h1;
      rec.h1.push({ gate: gates, h1, contract, view });
      const d = scen.gate(gates, { contract, h1, view, root, J, JD });
      if (d.edit) {
        // the user edits contract.md by hand instead of replying (the guard lets them)
        user('H1', 'edits contract.md by hand');
        d.edit({ root, J, JD });
        continue;
      }
      user('H1', d.deny ? `deny ${d.deny}` : 'approve');
      const r = F.say(root, d.deny ? `deny ${J} ${d.deny}` : `approve ${J} H1`);
      log(`you (H1 #${gates}): ${d.deny ? `deny (${(d.missing || []).join(', ')})` : 'approve'} → ${r.status}`);
      if (r.status !== 'applied') throw new Error(`gate reply not applied: ${r.text}`);
      if (d.deny) continue;
      closeTurn();
      rec.end = { action: 'approved', gates };
      break;
    }
    if (n.action === 'parked') {
      rec.parks.push(n.reason);
      const what = scen.onPark ? scen.onPark(rec.parks.length, n.reason, status()) : null;
      log(`parked: ${String(n.reason).slice(0, 200)} → ${what || 'stop'}`);
      if (!what) {
        closeTurn();
        rec.end = { action: 'parked', reason: n.reason };
        break;
      }
      user('park', what);
      const r = F.say(root, `${what} ${J}`);
      if (r.status !== 'applied') throw new Error(`${what} refused: ${r.text}`);
      continue;
    }
    closeTurn();
    rec.end = { action: n.action, step: n.step || null, next: n };
    break;
  }
  if (!rec.end) {
    closeTurn();
    rec.end = { action: 'max_steps' };
  }
  rec.final = status();
  rec.ledger = JSON.parse(fs.readFileSync(path.join(JD, 'clarify.json'), 'utf8'));
  rec.contract = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
  rec.calls = calls.map((c) => ({ agent: `factory:${c.role}`, label: c.label, model: c.model }));
  // how each agent came back, as the workflow's roster recorded it (sealed in the job's ledger)
  rec.agentRuns = fs.readFileSync(path.join(JD, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'agents' && e.workflow === 'clarify').flatMap((e) => e.agents.map((a) => ({ role: String(a.agent_type).replace(/^factory:/, ''), label: a.label, outcome: a.outcome })));
  rec.cli = cli;
  return rec;
}

module.exports = { drive, makeRepo, runStage, userSays };
