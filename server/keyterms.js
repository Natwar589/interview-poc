// Key terms for Deepgram's keyterm prompting (nova-3): words the interviewer is likely
// to say that generic speech models mishear ("React" -> "real", "Kafka" -> "café").
// Sources: a base list of common interview tech terms + terms pulled from the resume
// and job description.

const MAX_TERMS = 80; // Deepgram caps keyterm prompts at ~500 tokens; stay well under

const BASE_TERMS = [
  'React', 'Node.js', 'TypeScript', 'JavaScript', 'Python', 'Java', 'Golang', 'Kotlin',
  'Kubernetes', 'Docker', 'Kafka', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'DynamoDB',
  'GraphQL', 'REST API', 'gRPC', 'WebSocket', 'AWS', 'GCP', 'Azure', 'Terraform',
  'microservices', 'monolith', 'CI/CD', 'Next.js', 'Redux', 'Elasticsearch', 'RabbitMQ',
  'idempotency', 'sharding', 'load balancer', 'rate limiter', 'CAP theorem', 'OAuth',
  'STAR method', 'Agile', 'Scrum',
];

// Common capitalized words that are not worth boosting.
const STOP = new Set(
  ('the a an and or but for with from into over under about this that these those our your their ' +
   'i we you he she they it is are was were be been have has had do does did will would can could ' +
   'should may might must led built worked work working team teams company role years year months ' +
   'experience responsible including using used senior junior engineer engineering developer ' +
   'software manager lead requirements responsibilities qualifications skills strong excellent ' +
   'ability preferred plus bachelor master degree university college remote hybrid full time ' +
   'january february march april june july august september october november december present ' +
   'summary profile objective education projects job description').split(' '),
);

/**
 * Pull likely key terms from free text: acronyms (AWS), mixed case (PostgreSQL, iOS),
 * tech spellings with dots/digits/symbols (Node.js, C++, p99, k8s), capitalized
 * non-sentence-start words (Finlytics, Stripe), and long domain words (reconciliation).
 */
export function extractTerms(text = '') {
  const out = [];
  const tokens = text.match(/[A-Za-z][A-Za-z0-9.+#/-]*[A-Za-z0-9+#]|[A-Za-z]{2,}/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/[.,;:]+$/, '');
    const lower = t.toLowerCase();
    if (t.length < 2 || STOP.has(lower)) continue;
    const acronym = /^[A-Z]{2,6}s?$/.test(t);
    const mixedCase = /[a-z][A-Z]|^[a-z]+[A-Z]/.test(t);
    // "CI/CD" yes, "transactions/day" no: slashes only in short tokens.
    if (t.includes('/') && t.length > 6) continue;
    const techSpelling = /[.+#/]|\d/.test(t) && t.length >= 3;
    const properNoun = /^[A-Z][a-z]{2,}$/.test(t);
    const longWord = /^[a-z]{11,}$/.test(t);
    if (acronym || mixedCase || techSpelling || properNoun || longWord) out.push(t);
  }
  return out;
}

/** Base list + resume/JD terms, de-duplicated case-insensitively, capped. */
export function buildKeyterms({ resume = '', jobDescription = '' } = {}) {
  const seen = new Set();
  const terms = [];
  // Context terms first: they are the most specific to this interview.
  for (const t of [...extractTerms(jobDescription), ...extractTerms(resume), ...BASE_TERMS]) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}
