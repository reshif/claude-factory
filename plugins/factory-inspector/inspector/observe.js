'use strict';
// Builds what happened, per job and overall, from the factory's sealed records.

const fs = require('fs');
const { readJson, readLog, sealOk, layout, secret } = require('./io');

function jobIds(root) {
  const L = layout(root);
  try {
    return fs.readdirSync(L.jobs).filter((d) => /^J-\d+$/.test(d)).sort();
  } catch {
    return [];
  }
}

function observe(root) {
  const L = layout(root);
  const decisionsAll = readLog(L.decisions);
  const eventsAll = readLog(L.events);
  const jobs = {};
  // looks at what waits (factory inbox, factory drive status) belong to no job: every job sees them (R25)
  const looks = eventsAll.filter((e) => e.sealed && e.rec && ['inbox_viewed', 'drive_status_viewed'].includes(e.rec.event)).map((e) => e.rec);
  for (const id of jobIds(root)) {
    const p = L.job(id);
    const state = readJson(p.state, null);
    const lock = readJson(p.lock, null);
    // Clarify v3's ledger of items (clarify.json), sealed like state.json; absent before factory 0.16.0.
    const clarify = readJson(p.clarify, null);
    const ledgerLines = readLog(p.ledger);
    const decisions = decisionsAll.filter((d) => d.rec && d.rec.job === id);
    const events = eventsAll.filter((e) => e.rec && e.rec.job === id);
    jobs[id] = {
      id,
      state,
      lock,
      root, // for the outcome rules' read-only git (R23, R24) and the prompt log (R25)
      dir: p.dir,
      plan: readJson(p.plan, null),
      stateSealed: state ? sealOk(state) !== false : false,
      lockSealed: lock ? sealOk(lock) !== false : false,
      clarify,
      clarifySealed: clarify ? sealOk(clarify) !== false : true,
      ledgerLines,
      ledgerTorn: ledgerLines.filter((l) => l.torn).map((l) => l.line),
      ledger: ledgerLines.filter((l) => l.sealed && l.rec && l.rec.job === id).map((l) => l.rec),
      decisionLines: decisions,
      decisions: decisions.filter((d) => d.sealed).map((d) => d.rec),
      events: events.filter((e) => e.sealed).map((e) => e.rec),
      eventLines: events,
      globalEvents: looks,
    };
  }
  return {
    root,
    jobs,
    decisions: decisionsAll.filter((d) => d.sealed && d.rec).map((d) => d.rec),
    events: eventsAll.filter((e) => e.sealed && e.rec).map((e) => e.rec),
    unsealed: {
      decisions: decisionsAll.filter((d) => !d.sealed && !d.torn).map((d) => ({ line: d.line, job: d.rec && d.rec.job })),
      events: eventsAll.filter((e) => !e.sealed && !e.torn).map((e) => ({ line: e.line, job: e.rec && e.rec.job })),
    },
    // Lines that aren't JSON at all: a crashed or concurrent writer, or a hand edit.
    torn: {
      events: eventsAll.filter((e) => e.torn).map((e) => e.line),
      decisions: decisionsAll.filter((d) => d.torn).map((d) => d.line),
    },
    sealsChecked: Boolean(secret()),
    inspectorHookErrors: readLog(L.hookErrors).filter((l) => l.rec).map((l) => l.rec),
  };
}

const isRouting = (d) => d && d.action && !String(d.action).startsWith('human.');

module.exports = { observe, jobIds, isRouting };
