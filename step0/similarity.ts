// Step 0: similarity experiment.
// Turns 5 sentences into vectors (embeddings) and prints how similar every pair is.
// Run with: npx tsx step0/similarity.ts

import ollama from "ollama";

const sentences = [
  "The signal is red",
  "Stop at the signal",
  "The train must halt when the light shows danger",
  "I like pizza",
  "Cheese and tomato on a crispy base",
];

// One call embeds all sentences. Ollama runs nomic-embed-text and returns
// one vector (768 numbers) per sentence, in the same order.
const response = await ollama.embed({ model: "nomic-embed-text", input: sentences });
const vectors = response.embeddings;

console.log(`Got ${vectors.length} vectors, each with ${vectors[0].length} numbers.`);
console.log("First 5 numbers of sentence 1:", vectors[0].slice(0, 5));
console.log();

// Cosine similarity = how much two vectors point in the same direction.
//   dot(a, b) / (length(a) * length(b))
// 1 = same meaning, 0 = unrelated. This is what pgvector's <=> computes (as 1 - similarity).
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    lengthA += a[i] * a[i];
    lengthB += b[i] * b[i];
  }
  return dot / (Math.sqrt(lengthA) * Math.sqrt(lengthB));
}

// Compare every pair once (i < j), then sort so the most similar pairs come first.
const pairs: { a: string; b: string; score: number }[] = [];
for (let i = 0; i < sentences.length; i++) {
  for (let j = i + 1; j < sentences.length; j++) {
    pairs.push({ a: sentences[i], b: sentences[j], score: cosineSimilarity(vectors[i], vectors[j]) });
  }
}
pairs.sort((x, y) => y.score - x.score);

for (const p of pairs) {
  console.log(`${p.score.toFixed(3)}  "${p.a}"  <->  "${p.b}"`);
}
