'use strict';
// Lessons: short, scoped rules learned from confirmed problems. Agents propose,
// you accept or reject in chat. Accepted lessons feed plans, builds and reviews.

const { readJson, writeJson, nowIso, fail } = require('../lib/util');
const { project } = require('../lib/paths');
const { matchesAny, globsOverlap } = require('../lib/glob');

function load(root) {
  return readJson(project(root).lessonsFile, { lessons: [] });
}

function save(root, doc) {
  writeJson(project(root).lessonsFile, doc);
}

function add(root, { jobId, text, scope }) {
  if (!text || text.length < 10) fail('A lesson needs a sentence of text.', 'bad_input');
  const scopes = (Array.isArray(scope) ? scope : String(scope || '**').split(',')).map((s) => s.trim()).filter(Boolean);
  const doc = load(root);
  const job = require('./job');
  const state = jobId ? job.load(root, jobId) : null;
  const max = state ? state.policy.lessons_max_per_job : 3;
  const mine = doc.lessons.filter((l) => l.source_job === jobId);
  if (jobId && mine.length >= max) fail(`${jobId} already proposed ${max} lessons (the cap).`, 'cap');
  const id = `L${doc.lessons.length + 1}`;
  const lesson = { id, status: 'proposed', text, scope: scopes, source_job: jobId || null, created_at: nowIso() };
  doc.lessons.push(lesson);
  save(root, doc);
  return lesson;
}

function decide(root, { id, accept, reason, channel }) {
  require('./human').requireHumanChannel(channel);
  const doc = load(root);
  const l = doc.lessons.find((x) => x.id === id);
  if (!l) fail(`Lesson ${id} not found`, 'bad_input');
  if (l.status !== 'proposed') fail(`Lesson ${id} is already ${l.status}`, 'bad_input');
  l.status = accept ? 'accepted' : 'rejected';
  l.decided_at = nowIso();
  l.reason = reason || '';
  save(root, doc);
  return { lesson: l, message: `Lesson ${id} ${l.status}.${accept ? ' It applies from the next plan, build and review.' : ''}` };
}

function promote(root, { id, check, channel }) {
  require('./human').requireHumanChannel(channel);
  if (!check) fail('Promotion needs the check command that enforces the lesson.', 'bad_input');
  const doc = load(root);
  const l = doc.lessons.find((x) => x.id === id);
  if (!l || l.status !== 'accepted') fail(`Lesson ${id} must exist and be accepted`, 'bad_input');
  l.status = 'promoted';
  l.check = check;
  save(root, doc);
  const p = project(root).policyFile;
  const pol = readJson(p, {}) || {};
  pol.checks = [...(pol.checks || []), { cmd: check, from_lesson: id }];
  writeJson(p, pol);
  return { lesson: l, message: `Lesson ${id} promoted to a check: ${check}` };
}

// Accepted lessons whose scope touches any of the given paths or globs.
function inScope(root, pathsOrGlobs) {
  const list = Array.isArray(pathsOrGlobs) ? pathsOrGlobs : [];
  return load(root)
    .lessons.filter((l) => l.status === 'accepted' || l.status === 'promoted')
    .filter((l) => !list.length || l.scope.includes('**') || list.some((p) => matchesAny(p, l.scope)) || globsOverlap(l.scope, list))
    .map((l) => ({ id: l.id, text: l.text, scope: l.scope }));
}

module.exports = { load, add, decide, promote, inScope };
