import mongoose from 'mongoose';
import Chunk from '../models/Chunk.js';
import { embedTexts } from './embedding.js';

// MongoDB Atlas Vector Search using $vectorSearch (MongoDB Server 7.0+ / Atlas)
export async function vectorSearch(queryVector, topK=5) {
  const collection = mongoose.connection.collection('chunks');
  const pipeline = [
    {
      $vectorSearch: {
        index: 'vector_index', // create in Atlas UI
        path: 'vector',
        queryVector,
        numCandidates: Math.max(100, topK*10),
        limit: topK
      }
    },
    { $project: { text:1, metadata:1, source:1, page:1, type:1, score: { $meta: 'vectorSearchScore' } } }
  ];
  const results = await collection.aggregate(pipeline).toArray();
  return results;
}

// Simple answer generation without OpenAI (free alternative)
async function generateAnswer(question, contexts) {
  if (!contexts.length) {
    return 'No relevant context found.';
  }

  // Simple ranking and context aggregation
  const topContexts = contexts.slice(0, 3); // Use top 3 contexts
  const combinedText = topContexts
    .map((ctx, i) => `[${i + 1}] ${ctx.text}`)
    .join('\n\n');

  // For assessment purposes, return the most relevant context with some formatting
  return `Based on the document analysis:\n\n${combinedText}`;
}

export async function queryRAG(question, topK=5) {
  console.log(`🔍 Processing query: "${question}"`);
  
  // Generate embedding for the question using HuggingFace Transformers
  const [qv] = await embedTexts([question]);
  console.log(`✅ Generated query embedding (${qv.length} dimensions)`);
  
  // Perform vector search
  const hits = await vectorSearch(qv, topK);
  console.log(`📊 Found ${hits.length} relevant contexts`);
  
  // Generate answer from contexts
  const answer = await generateAnswer(question, hits);
  
  return {
    answer: answer,
    contexts: hits.map(h => ({
      text: h.text,
      metadata: h.metadata || {},
      source: h.source,
      page: h.page,
      type: h.type,
      score: h.score
    }))
  };
}
