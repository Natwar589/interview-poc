// Key terms for Deepgram's keyterm prompting (nova-3): words the interviewer is likely
// to say that generic speech models mishear ("React" -> "real", "Kafka" -> "café").
// Sources: a base list of common interview tech terms + terms pulled from the resume
// and job description.

const MAX_TERMS = 100; // Deepgram caps keyterm prompts at ~500 tokens; this stays well under

const BASE_TERMS = [
  'React', 'Node.js', 'TypeScript', 'JavaScript', 'Python', 'Java', 'Golang', 'Kotlin',
  'Kubernetes', 'Docker', 'Kafka', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'DynamoDB',
  'GraphQL', 'REST API', 'gRPC', 'WebSocket', 'AWS', 'GCP', 'Azure', 'Terraform',
  'microservices', 'monolith', 'CI/CD', 'Next.js', 'Redux', 'Elasticsearch', 'RabbitMQ',
  'idempotency', 'sharding', 'load balancer', 'rate limiter', 'CAP theorem', 'OAuth',
  'STAR method', 'Agile', 'Scrum',
  // Coding-interview vocabulary (a live test heard "house robber" as "house and job",
  // "array" as "zero", "code" as "call").
  'C++', 'code', 'array', 'median', 'linked list', 'binary tree', 'binary search', 'hash map',
  'dynamic programming', 'recursion', 'sliding window', 'two pointers', 'heap', 'stack', 'queue',
  'graph', 'BFS', 'DFS', 'Big O', 'time complexity', 'LeetCode', 'house robber', 'two sum',
  'compare', 'difference between', 'RAG', 'LLM', 'MCP', 'server-sent events',
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
   'summary profile objective education projects job description company sample products product ' +
   'platform platforms service services apps app india remote onsite').split(' '),
);

// Words that commonly open a sentence or bullet in resumes and job descriptions; a
// capital there means nothing. Other capitalised sentence starts (project and company
// names like "Mushroom", "Walkover") are kept, ranked below mid-sentence names.
const COMMON_STARTS = new Set(
  ('build built building use used using design designed designing implement implemented ' +
   'develop developed developing create created creating improve improved write wrote ' +
   'work worked help helped drive drove own owned deliver delivered collaborate maintain ' +
   'maintained ensure support supported manage managed optimize optimized integrate ' +
   'integrated deploy deployed test tested lead what who why how when where if as at in ' +
   'on by to of for with from all any each our you we they this that these those it ' +
   'nice must should will about join responsibilities requirements qualifications benefits ' +
   'full key strong excellent good great new also').split(' '),
);

/**
 * Pull likely key terms from free text, most useful first: tech spellings with dots,
 * digits or symbols (Node.js, C++, p99, GTWY.AI), acronyms (AWS), mixed case
 * (PostgreSQL), then capitalised words mid-sentence (Finlytics, Stripe), then
 * capitalised sentence starts that aren't common words (Mushroom), then long domain
 * words (reconciliation).
 */
export function extractTerms(text = '') {
  const ranked = [[], [], [], [], []];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9.+#/-]*[A-Za-z0-9+#]|[A-Za-z]{2,}/g)) {
    const t = m[0].replace(/[.,;:]+$/, '');
    const lower = t.toLowerCase();
    if (t.length < 2 || STOP.has(lower)) continue;
    // "CI/CD" yes, "transactions/day" no: slashes only in short tokens.
    if (t.includes('/') && t.length > 6) continue;
    // Sentence or list start: a capital there says nothing ("Build", "Use", "Design").
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart = !before || /[.!?:;•\-–(\n]$/.test(before) || /\n\s*$/.test(text.slice(0, m.index));
    if (/[.+#/]|\d/.test(t) && t.length >= 3) ranked[0].push(t);
    else if (/^[A-Z]{2,6}s?$/.test(t) || /[a-z][A-Z]|^[a-z]+[A-Z]/.test(t)) ranked[1].push(t);
    else if (/^[A-Z][a-z]{2,}$/.test(t)) {
      if (!sentenceStart) ranked[2].push(t);
      else if (!COMMON_STARTS.has(lower)) ranked[3].push(t);
    } else if (/^[a-z]{11,}$/.test(t)) ranked[4].push(t);
  }
  return ranked.flat();
}

/**
 * The base list always goes in (it covers what interviewers commonly say and gets
 * misheard); resume and job-description terms fill the remaining slots, the job
 * description first. Before this, a long resume + JD pushed the whole base list out.
 */
export function buildKeyterms({ resume = '', jobDescription = '' } = {}) {
  const seen = new Set();
  const terms = [];
  const add = (t) => {
    const key = t.toLowerCase();
    if (seen.has(key) || terms.length >= MAX_TERMS) return;
    seen.add(key);
    terms.push(t);
  };
  BASE_TERMS.forEach(add);
  for (const t of [...extractTerms(jobDescription), ...extractTerms(resume)]) add(t);
  return terms;
}
