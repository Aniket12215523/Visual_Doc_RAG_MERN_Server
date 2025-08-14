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

// Universal answer generation that adapts to any document type
async function generateAnswer(question, contexts) {
  if (!contexts.length) {
    return 'No relevant context found.';
  }

  const questionLower = question.toLowerCase();
  const bestContext = contexts[0];
  const contextText = bestContext.text;
  const documentType = detectDocumentType(contexts);

  // Universal question handlers that work across document types
  
  // NAME/PERSON queries
  if (questionLower.includes('name') || questionLower.includes('who')) {
    const names = extractNames(contextText);
    if (names.length > 0) {
      return names.length === 1 
        ? `The name mentioned is: **${names[0]}**`
        : `Names mentioned: **${names.join(', ')}**`;
    }
  }

  // NUMBER/AMOUNT/VALUE queries
  if (questionLower.includes('revenue') || questionLower.includes('amount') || 
      questionLower.includes('total') || questionLower.includes('value') ||
      questionLower.includes('number') || questionLower.includes('cost') ||
      questionLower.includes('price') || questionLower.includes('profit')) {
    const numbers = extractNumbers(contextText);
    if (numbers.length > 0) {
      return `**Key figures found:**\n${numbers.map(n => `• ${n}`).join('\n')}`;
    }
  }

  // DATE/TIME queries
  if (questionLower.includes('date') || questionLower.includes('when') || 
      questionLower.includes('year') || questionLower.includes('time')) {
    const dates = extractDates(contextText);
    if (dates.length > 0) {
      return `**Dates mentioned:**\n${dates.map(d => `• ${d}`).join('\n')}`;
    }
  }

  // PERCENTAGE/GROWTH queries
  if (questionLower.includes('percent') || questionLower.includes('%') || 
      questionLower.includes('growth') || questionLower.includes('increase') ||
      questionLower.includes('decrease') || questionLower.includes('change')) {
    const percentages = extractPercentages(contextText);
    if (percentages.length > 0) {
      return `**Percentages/Changes:**\n${percentages.map(p => `• ${p}`).join('\n')}`;
    }
  }

  // COMPARISON queries
  if (questionLower.includes('compare') || questionLower.includes('vs') || 
      questionLower.includes('versus') || questionLower.includes('difference')) {
    return extractComparisons(contexts);
  }

  // CHART/GRAPH queries
  if (questionLower.includes('chart') || questionLower.includes('graph') || 
      questionLower.includes('trend') || questionLower.includes('data')) {
    const chartContexts = contexts.filter(c => c.type === 'chart_ocr');
    if (chartContexts.length > 0) {
      return `**Chart/Graph Analysis:**\n${chartContexts[0].text.substring(0, 300)}...`;
    }
  }

  // SUMMARY queries
  if (questionLower.includes('summary') || questionLower.includes('overview') || 
      questionLower.includes('about') || questionLower.includes('what is')) {
    return generateSmartSummary(contexts, documentType);
  }

  // LOCATION queries
  if (questionLower.includes('where') || questionLower.includes('location') || 
      questionLower.includes('address') || questionLower.includes('city')) {
    const locations = extractLocations(contextText);
    if (locations.length > 0) {
      return `**Locations mentioned:**\n${locations.map(l => `• ${l}`).join('\n')}`;
    }
  }

  // Default: Smart contextual response
  return generateContextualAnswer(question, contexts, documentType);
}

// Helper functions for universal extraction

function detectDocumentType(contexts) {
  const allText = contexts.map(c => c.text).join(' ').toLowerCase();
  
  if (allText.includes('revenue') || allText.includes('profit') || 
      allText.includes('sales') || allText.includes('financial')) {
    return 'financial';
  }
  if (allText.includes('skills') || allText.includes('projects') || 
      allText.includes('education') || allText.includes('experience')) {
    return 'resume';
  }
  if (allText.includes('chart') || allText.includes('graph') || 
      allText.includes('axis') || allText.includes('legend')) {
    return 'chart';
  }
  if (allText.includes('report') || allText.includes('analysis')) {
    return 'report';
  }
  return 'general';
}

function extractNames(text) {
  const namePatterns = [
    /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,  // Full names
    /Name:?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,       // "Name: John Doe"
    /(?:Mr|Ms|Mrs|Dr)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi  // Titles
  ];
  
  const names = new Set();
  namePatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => {
      const name = match[1] || match[0];
      if (name && name.length > 3 && name.length < 50) {
        names.add(name.trim());
      }
    });
  });
  
  return Array.from(names);
}

function extractNumbers(text) {
  const numberPatterns = [
    /(?:revenue|profit|sales|total|amount|value|cost|price):\s*\$?([\d,]+(?:\.\d{2})?)/gi,
    /\$?([\d,]+(?:\.\d{2})?)\s*(?:million|billion|thousand|M|B|K)/gi,
    /\$?([\d,]+(?:\.\d{2})?)/g
  ];
  
  const numbers = new Set();
  numberPatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => {
      if (match[1]) {
        numbers.add(match[0].trim());
      }
    });
  });
  
  return Array.from(numbers).slice(0, 10); // Limit to top 10
}

function extractDates(text) {
  const datePatterns = [
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,           // MM/DD/YYYY
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,             // YYYY-MM-DD
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi,
    /\b\d{4}\b/g                              // Just years
  ];
  
  const dates = new Set();
  datePatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => dates.add(match[0]));
  });
  
  return Array.from(dates);
}

function extractPercentages(text) {
  const percentagePatterns = [
    /\b\d+(?:\.\d+)?%/g,
    /increased?\s+by\s+(\d+(?:\.\d+)?%?)/gi,
    /decreased?\s+by\s+(\d+(?:\.\d+)?%?)/gi,
    /growth\s+of\s+(\d+(?:\.\d+)?%?)/gi
  ];
  
  const percentages = new Set();
  percentagePatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => percentages.add(match[0] || match[1]));
  });
  
  return Array.from(percentages);
}

function extractLocations(text) {
  const locationPatterns = [
    /\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/g,       // City, State
    /\b[A-Z][a-z]+,\s*[A-Z]{2}\b/g,          // City, ST
    /\b\d+\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard)\b/gi
  ];
  
  const locations = new Set();
  locationPatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => locations.add(match[0]));
  });
  
  return Array.from(locations);
}

function extractComparisons(contexts) {
  const comparisons = [];
  contexts.forEach(context => {
    const text = context.text;
    // Look for comparative language
    const compPatterns = [
      /(\d+(?:\.\d+)?\%?)\s+(?:vs|versus|compared to)\s+(\d+(?:\.\d+)?\%?)/gi,
      /increased?\s+from\s+(\$?[\d,]+)\s+to\s+(\$?[\d,]+)/gi,
      /(?:higher|lower|greater|less)\s+than\s+(\$?[\d,]+(?:\.\d+)?)/gi
    ];
    
    compPatterns.forEach(pattern => {
      const matches = [...text.matchAll(pattern)];
      matches.forEach(match => comparisons.push(match[0]));
    });
  });
  
  return comparisons.length > 0 
    ? `**Comparisons found:**\n${comparisons.map(c => `• ${c}`).join('\n')}`
    : generateContextualAnswer('comparison', contexts, 'general');
}

function generateSmartSummary(contexts, documentType) {
  const keyPoints = [];
  
  contexts.forEach(context => {
    const sentences = context.text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    // Take first 2 sentences from each context
    keyPoints.push(...sentences.slice(0, 2).map(s => s.trim()));
  });
  
  const uniquePoints = [...new Set(keyPoints)].slice(0, 5);
  
  return `**Document Summary:**\n${uniquePoints.map(p => `• ${p}`).join('\n')}`;
}

function generateContextualAnswer(question, contexts, documentType) {
  const bestContext = contexts[0];
  const contextText = bestContext.text;
  
  // Extract most relevant sentence or paragraph
  const sentences = contextText.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const questionWords = question.toLowerCase().split(/\s+/);
  
  // Find sentence with most question word matches
  let bestSentence = sentences[0];
  let maxMatches = 0;
  
  sentences.forEach(sentence => {
    const sentenceLower = sentence.toLowerCase();
    const matches = questionWords.filter(word => 
      word.length > 3 && sentenceLower.includes(word)
    ).length;
    
    if (matches > maxMatches) {
      maxMatches = matches;
      bestSentence = sentence;
    }
  });
  
  return `**Based on the document:**\n${bestSentence.trim()}`;
}

export async function queryRAG(question, topK=5) {
  console.log(`🔍 Processing query: "${question}"`);
  
  const [qv] = await embedTexts([question]);
  console.log(`✅ Generated query embedding (${qv.length} dimensions)`);
  
  const hits = await vectorSearch(qv, topK);
  console.log(`📊 Found ${hits.length} relevant contexts`);
  
  // Generate intelligent answer for any document type
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
