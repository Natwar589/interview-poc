import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUtterance, QuestionDetector } from '../server/questionDetector.js';

const cases = [
  ['Tell me about yourself.', 'question', true],
  ['Why do you want to work here?', 'question', true],
  ['Great, thanks. So how would you design a rate limiter?', 'question', true],
  ['Walk me through a project you are proud of.', 'question', true],
  ['Can you describe a time you disagreed with your manager?', 'question', true],
  ['What is the difference between a process and a thread', 'question', false],
  ['So tell me about the', 'question', false],
  ['Okay.', 'filler', true],
  ['Yeah, got it, makes sense.', 'filler', true],
  ['Can you hear me okay?', 'smalltalk', true],
  ['How are you doing today?', 'smalltalk', true],
  ['We use Kafka for most of our event pipelines.', 'statement', true],
];

for (const [text, kind, complete] of cases) {
  test(`classify: ${text}`, () => {
    const r = classifyUtterance(text);
    assert.equal(r.kind, kind, r.reason);
    if (kind === 'question') assert.equal(r.complete, complete);
  });
}

test('strips leading acknowledgements from the question text', () => {
  const r = classifyUtterance('Great, thanks. So how would you design a rate limiter?');
  assert.equal(r.question, 'So how would you design a rate limiter?');
  assert.equal(r.lead, 'Great, thanks.');
});

test('detector fires on a complete question at the pause', () => {
  const fired = [];
  const d = new QuestionDetector({ onQuestion: (q) => fired.push(q) });
  d.onFinal('Why do you want this role?', { speechFinal: true, speechEndAt: Date.now() });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, 'Why do you want this role?');
});

test('detector holds an unfinished question and keeps listening', async () => {
  const fired = [];
  const d = new QuestionDetector({ holdMs: 50, onQuestion: (q) => fired.push(q) });
  d.onFinal('Tell me about a time when', { speechFinal: true });
  d.onInterim('you led'); // speaker continues: hold cancelled
  d.onFinal('you led a team through a hard deadline.', { speechFinal: true });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired.length, 1);
  assert.match(fired[0].text, /hard deadline/);
});

test('statements become preamble for the next question', () => {
  const fired = [];
  const d = new QuestionDetector({ onQuestion: (q) => fired.push(q), onSkipped: () => {} });
  d.onFinal('Our system handles a million reads per second.', { speechFinal: true });
  d.onUtteranceEnd();
  d.onFinal('How would you cache it?', { speechFinal: true });
  assert.equal(fired.length, 1);
  assert.match(fired[0].preamble, /million reads/);
});

test('filler is skipped, not answered', () => {
  const fired = [];
  const skipped = [];
  const d = new QuestionDetector({ onQuestion: (q) => fired.push(q), onSkipped: (s) => skipped.push(s) });
  d.onFinal('Okay, cool.', { speechFinal: true });
  assert.equal(fired.length, 0);
  assert.equal(skipped[0].kind, 'filler');
});

test('small talk early in the buffer does not hide a later question', () => {
  const r = classifyUtterance(
    "Okay. Great. Thanks for joining. So can you hear me okay? Alright. Tell me about a project you're really proud of.",
  );
  assert.equal(r.kind, 'question');
  assert.equal(r.question, "Tell me about a project you're really proud of.");
});

test('with several questions buffered, the latest one is answered', () => {
  const r = classifyUtterance(
    "Tell me about a project you're proud of. Interesting. And how would you design a rate limiter?",
  );
  assert.equal(r.question, 'And how would you design a rate limiter?');
  assert.match(r.lead, /project you're proud of/);
});

test('a fragment cut mid-sentence is kept and completed by the next segment', () => {
  const fired = [];
  const d = new QuestionDetector({ onQuestion: (q) => fired.push(q), onSkipped: () => {} });
  d.onFinal('Okay. Great. So can you hear me okay? Alright. Tell me', { speechFinal: true });
  assert.equal(fired.length, 0);
  d.onFinal("about a project you're really proud of.", { speechFinal: true });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, "Tell me about a project you're really proud of.");
});

test('two-word questions with a question word count, other two-word phrases do not', () => {
  assert.equal(classifyUtterance('Is React?').kind, 'question');
  assert.equal(classifyUtterance('Why Kafka?').kind, 'question');
  assert.notEqual(classifyUtterance('You sure?').kind, 'question');
  assert.notEqual(classifyUtterance('Really?').kind, 'question');
});

test('hold timer never answers a fragment that dangles on "to"', async () => {
  const fired = [];
  const d = new QuestionDetector({ holdMs: 30, onQuestion: (q) => fired.push(q), onSkipped: () => {} });
  d.onFinal('How does Kafka compare to', { speechFinal: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired.length, 0);
  d.onFinal('RabbitMQ?', { speechFinal: true });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, 'How does Kafka compare to RabbitMQ?');
});

test('"compare X and Y" style prompts are questions', () => {
  assert.equal(classifyUtterance('Compare Kafka and Redis.').kind, 'question');
  assert.equal(classifyUtterance('Explain the difference between TCP and UDP.').kind, 'question');
  assert.equal(classifyUtterance('Pros and cons of microservices.').kind, 'question');
});
