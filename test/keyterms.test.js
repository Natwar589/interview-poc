import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTerms, buildKeyterms } from '../server/keyterms.js';

const resume =
  'Priya Sharma. Backend engineer, 4 years. Node.js, PostgreSQL, Redis, AWS. At Finlytics built a ' +
  'payments reconciliation service handling 2M transactions/day; cut p99 latency 40%.';

test('extracts tech spellings, acronyms, product names and domain words', () => {
  const terms = extractTerms(resume);
  for (const t of ['Node.js', 'PostgreSQL', 'Redis', 'AWS', 'Finlytics', 'reconciliation', 'p99']) {
    assert.ok(terms.includes(t), `missing ${t} in ${terms}`);
  }
});

test('skips common words', () => {
  const terms = extractTerms('The Senior Engineer will work with the Team on Requirements.');
  assert.deepEqual(terms, []);
});

test('base list is always present, so "React" is boosted without any context', () => {
  assert.ok(buildKeyterms({}).includes('React'));
});

test('de-duplicates case-insensitively and caps the list', () => {
  const terms = buildKeyterms({ resume: 'React react REACT Redis', jobDescription: 'redis' });
  assert.equal(terms.filter((t) => t.toLowerCase() === 'react').length, 1);
  assert.equal(terms.filter((t) => t.toLowerCase() === 'redis').length, 1);
  const many = Array.from({ length: 200 }, (_, i) => `Product${i}x`).join(' ');
  assert.ok(buildKeyterms({ resume: many }).length <= 80);
});
