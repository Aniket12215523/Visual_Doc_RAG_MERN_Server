import mongoose from 'mongoose';
import Chunk from '../models/Chunk.js';
import { embedTexts } from './embedding.js';

export async function vectorSearch(queryVector, topK=5) {
  const collection = mongoose.connection.collection('chunks');
  const pipeline = [
    {
      $vectorSearch: {
        index: 'vector_index',
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

// Enhanced answer generation with question-specific extraction
async function generateAnswer(question, contexts) {
  if (!contexts.length) {
    return 'No relevant context found.';
  }

  const questionLower = question.toLowerCase();
  const bestContext = contexts[0];
  const contextText = bestContext.text;

  // Name extraction
  if (questionLower.includes('name')) {
    // Try multiple name extraction patterns
    const namePatterns = [
      /^([A-Z][a-z]+\s+[A-Z][a-z]+)/,  // "Aniket Kumar" at start
      /Name:?\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i,  // "Name: Aniket Kumar"
      /([A-Z][a-z]+\s+[A-Z][a-z]+)\s+LinkedIn:/i,  // "Aniket Kumar LinkedIn:"
    ];

    for (const pattern of namePatterns) {
      const match = contextText.match(pattern);
      if (match && match[1]) {
        return `The name in the resume is: **${match[1].trim()}**`;
      }
    }
    
    // Fallback: first line that looks like a name
    const firstLine = contextText.split('\n')[0].trim();
    if (firstLine.length < 50 && /^[A-Z][a-z]+\s+[A-Z]/.test(firstLine)) {
      return `The name in the resume is: **${firstLine}**`;
    }
  }

  // Skills extraction
  if (questionLower.includes('skill') || questionLower.includes('technology') || questionLower.includes('programming')) {
    const skillsMatch = contextText.match(/SKILLS[\s\S]*?(?=PROJECTS|CERTIFICATES|EDUCATION|$)/i);
    if (skillsMatch) {
      return `**Skills and Technologies:**\n\n${skillsMatch[0].trim()}`;
    }
  }

  // Project extraction
  if (questionLower.includes('project')) {
    const projectsMatch = contextText.match(/PROJECTS[\s\S]*?(?=CERTIFICATES|ACHIEVEMENTS|EDUCATION|$)/i);
    if (projectsMatch) {
      return `**Projects:**\n\n${projectsMatch[0].trim()}`;
    }
  }

  // Education extraction
  if (questionLower.includes('education') || questionLower.includes('university') || questionLower.includes('degree')) {
    const educationMatch = contextText.match(/EDUCATION[\s\S]*$/i);
    if (educationMatch) {
      return `**Education:**\n\n${educationMatch[0].trim()}`;
    }
  }

  // Contact extraction
  if (questionLower.includes('contact') || questionLower.includes('email') || questionLower.includes('phone')) {
    const contactPattern = /(LinkedIn:|Email:|GitHub:|Mobile:)[\s\S]*?(?=SKILLS|$)/i;
    const contactMatch = contextText.match(contactPattern);
    if (contactMatch) {
      return `**Contact Information:**\n\n${contactMatch[0].trim()}`;
    }
  }

  // Default: return a concise summary
  const summary = contextText.substring(0, 200).trim();
  return `Based on the document: ${summary}${contextText.length > 200 ? '...' : ''}`;
}

export async function queryRAG(question, topK=5) {
  console.log(`🔍 Processing query: "${question}"`);
  
  const [qv] = await embedTexts([question]);
  console.log(`✅ Generated query embedding (${qv.length} dimensions)`);
  
  const hits = await vectorSearch(qv, topK);
  console.log(`📊 Found ${hits.length} relevant contexts`);
  
  // Generate intelligent answer
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
