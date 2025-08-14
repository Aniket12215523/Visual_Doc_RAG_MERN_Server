import path from 'path';
import mongoose from 'mongoose';
import Chunk from '../models/Chunk.js';
import { embedTexts } from './embedding.js';

export async function vectorSearch(queryVector, topK=5, sourceFilter = null) {
  const collection = mongoose.connection.collection('chunks');
  
  let pipeline = [
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'vector',
        queryVector,
        numCandidates: Math.max(100, topK*10),
        limit: topK * 3 // Get more results for better filtering
      }
    }
  ];

  // Add source filter if specified
  if (sourceFilter) {
    pipeline.push({
      $match: {
        source: { $regex: sourceFilter, $options: 'i' }
      }
    });
  }

  pipeline.push({
    $project: { text:1, metadata:1, source:1, page:1, type:1, score: { $meta: 'vectorSearchScore' } }
  });

  const results = await collection.aggregate(pipeline).toArray();
  
  // Filter out very low-quality results and limit to topK
  return results
    .filter(result => result.score > 0.4) // Minimum relevance threshold
    .slice(0, topK);
}

// Fixed universal answer generation without hard-coded responses
async function generateAnswer(question, contexts) {
  if (!contexts.length) {
    return 'No relevant context found.';
  }

  const questionLower = question.toLowerCase();
  
  // Group contexts by document source to prioritize same-document results
  const contextsBySource = groupContextsBySource(contexts);
  const primarySource = Object.keys(contextsBySource)[0]; // Most relevant document
  const primaryContexts = contextsBySource[primarySource];

  console.log(`🎯 Primary document: ${path.basename(primarySource)}`);
  console.log(`📄 Using ${primaryContexts.length} contexts from primary document`);

  const documentType = detectDocumentType(primaryContexts);
  const bestContext = primaryContexts[0];
  const contextText = bestContext.text;

  // Certificate-specific handling (FIXED - no hard-coded responses)
  if (documentType === 'certificate' || questionLower.includes('certificate') || questionLower.includes('certification')) {
    return handleCertificateQuery(questionLower, primaryContexts);
  }

  // NAME/PERSON queries
  if (questionLower.includes('name') || questionLower.includes('who')) {
    const names = extractNames(contextText);
    if (names.length > 0) {
      return names.length === 1 
        ? `The name mentioned is: **${names[0]}**`
        : `Names mentioned: **${names.join(', ')}**`;
    }
  }

  // COURSE/TRAINING queries
  if (questionLower.includes('course') || questionLower.includes('training') || questionLower.includes('program')) {
    const courses = extractCourses(contextText);
    if (courses.length > 0) {
      return `**Course/Training Information:**\n${courses.map(c => `• ${c}`).join('\n')}`;
    }
  }

  // COMPANY/ORGANIZATION queries
  if (questionLower.includes('company') || questionLower.includes('organization') || questionLower.includes('issued by')) {
    const orgs = extractOrganizations(contextText);
    if (orgs.length > 0) {
      return `**Organization/Company:**\n${orgs.map(o => `• ${o}`).join('\n')}`;
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

  // SUMMARY queries
  if (questionLower.includes('summary') || questionLower.includes('overview') || 
      questionLower.includes('about') || questionLower.includes('what is')) {
    return generateSmartSummary(primaryContexts, documentType);
  }

  // Default: Enhanced contextual response from primary document only
  return generateContextualAnswer(question, primaryContexts, documentType);
}

// Group contexts by source document
function groupContextsBySource(contexts) {
  const grouped = {};
  contexts.forEach(context => {
    const source = context.source;
    if (!grouped[source]) {
      grouped[source] = [];
    }
    grouped[source].push(context);
  });

  // Sort sources by total relevance score
  const sortedSources = Object.keys(grouped).sort((a, b) => {
    const scoreA = grouped[a].reduce((sum, ctx) => sum + ctx.score, 0);
    const scoreB = grouped[b].reduce((sum, ctx) => sum + ctx.score, 0);
    return scoreB - scoreA;
  });

  const result = {};
  sortedSources.forEach(source => {
    result[source] = grouped[source];
  });

  return result;
}

// FIXED certificate handling - reads actual document content
function handleCertificateQuery(questionLower, contexts) {
  const allText = contexts.map(c => c.text).join(' ');
  const cleanedText = cleanAndFormatText(allText);

  console.log(`🔍 Certificate text preview: ${cleanedText.substring(0, 200)}...`);

  if (questionLower.includes('about') || questionLower.includes('what')) {
    const certInfo = extractCertificateInfo(cleanedText);
    
    if (certInfo.hasInfo) {
      const response = [
        `**Certificate Type:** ${certInfo.type}`,
        `**Issued By:** ${certInfo.issuer}`,
        `**Recipient:** ${certInfo.recipient}`,
        `**Course/Program:** ${certInfo.course}`,
        `**Date:** ${certInfo.date}`
      ].filter(line => !line.includes('Unknown')); // Remove unknown fields

      return response.join('\n');
    }
  }

  // Fallback to meaningful sentences from actual document
  const sentences = cleanedText.split(/[.!?]+/)
    .filter(s => s.trim().length > 15 && /[a-zA-Z]/.test(s))
    .slice(0, 3);
  
  return sentences.length > 0 
    ? `**Certificate Details:**\n${sentences.map(s => `• ${s.trim()}`).join('\n')}`
    : `**Document Content:** ${cleanedText.substring(0, 300)}...`;
}

// Extract certificate information from actual text content
function extractCertificateInfo(text) {
  const info = {
    type: 'Unknown',
    issuer: 'Unknown',
    recipient: 'Unknown', 
    course: 'Unknown',
    date: 'Unknown',
    hasInfo: false
  };

  // Extract recipient (name)
  const namePatterns = [
    /(?:awarded to|presented to|certificate.*?to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /([A-Z][a-z]+\s+[A-Z][a-z]+)(?=\s+for\s+successfully)/gi
  ];
  
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match) {
      info.recipient = match[1] || match[0];
      info.hasInfo = true;
      break;
    }
  }

  // Extract issuer/company
  const issuerPatterns = [
    /\b(Infosys|Google|Microsoft|Amazon|IBM|Oracle|Coursera|edX)\b/gi,
    /\b([A-Z][a-z]+\s+(?:University|Institute|College|Academy))\b/gi,
    /\b([A-Z][a-z]+\s+Professional\s+University)\b/gi
  ];
  
  for (const pattern of issuerPatterns) {
    const match = text.match(pattern);
    if (match) {
      info.issuer = match[0];
      info.hasInfo = true;
      break;
    }
  }

  // Extract course/program
  const coursePatterns = [
    /(?:completing the course|course in|program in)\s+([^.!?]+)/gi,
    /(AI-first Software Engineering|Software Engineering|Data Science|Machine Learning|Cloud Computing)/gi
  ];
  
  for (const pattern of coursePatterns) {
    const match = text.match(pattern);
    if (match) {
      info.course = match[1] || match[0];
      info.hasInfo = true;
      break;
    }
  }

  // Extract date
  const dateMatch = text.match(/(?:on|issued on:|date:)\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/gi);
  if (dateMatch) {
    info.date = dateMatch[0].replace(/^(on|issued on:|date:)\s*/i, '');
    info.hasInfo = true;
  }

  // Determine certificate type
  if (text.toLowerCase().includes('software engineering')) {
    info.type = 'Software Engineering Certificate';
  } else if (text.toLowerCase().includes('internship')) {
    info.type = 'Internship Certificate';
  } else if (text.toLowerCase().includes('course completion')) {
    info.type = 'Course Completion Certificate';
  } else if (info.course !== 'Unknown') {
    info.type = 'Professional Certificate';
  }

  return info;
}

// Helper functions for extraction
function extractCourses(text) {
  const coursePatterns = [
    /(AI-first Software Engineering|Software Engineering|Data Science|Machine Learning|Cloud Computing)/gi,
    /(?:course|training|program):\s*([^.!?\n]+)/gi
  ];
  
  const courses = new Set();
  coursePatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => {
      if (match[1] && match[1].trim().length > 5) {
        courses.add(match[1].trim());
      }
    });
  });
  
  return Array.from(courses);
}

function extractOrganizations(text) {
  const orgPatterns = [
    /\b(Infosys|Google|Microsoft|Amazon|IBM|Oracle|Coursera|edX|Udemy)\b/gi,
    /\b([A-Z][a-z]+\s+(?:University|Institute|College|Academy|Corporation|Limited|Ltd))\b/gi
  ];
  
  const orgs = new Set();
  orgPatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => orgs.add(match[0]));
  });
  
  return Array.from(orgs);
}

// Enhanced text cleaning function
function cleanAndFormatText(text) {
  return text
    .replace(/[^\w\s.,!?@()-:\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// Enhanced helper functions (keeping existing ones)
function detectDocumentType(contexts) {
  const allText = contexts.map(c => c.text).join(' ').toLowerCase();
  
  if (allText.includes('certificate') || allText.includes('awarded') || 
      allText.includes('presented') || allText.includes('issued')) {
    return 'certificate';
  }
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
  return 'general';
}

function extractNames(text) {
  const cleanText = cleanAndFormatText(text);
  const namePatterns = [
    /\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /(?:awarded to|presented to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi
  ];
  
  const names = new Set();
  namePatterns.forEach(pattern => {
    const matches = [...cleanText.matchAll(pattern)];
    matches.forEach(match => {
      const name = match[1] || match[0];
      if (name && name.length > 3 && name.length < 50) {
        names.add(name.trim());
      }
    });
  });
  
  return Array.from(names);
}

function extractDates(text) {
  const datePatterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g
  ];
  
  const dates = new Set();
  datePatterns.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => dates.add(match[0]));
  });
  
  return Array.from(dates);
}

function generateSmartSummary(contexts, documentType) {
  const keyPoints = [];
  
  contexts.forEach(context => {
    const cleanedText = cleanAndFormatText(context.text);
    const sentences = cleanedText.split(/[.!?]+/)
      .filter(s => s.trim().length > 20 && /[a-zA-Z]/.test(s))
      .map(s => s.trim());
    
    keyPoints.push(...sentences.slice(0, 2));
  });
  
  const uniquePoints = [...new Set(keyPoints)].slice(0, 4);
  
  return `**Document Summary:**\n${uniquePoints.map(p => `• ${p}`).join('\n')}`;
}

function generateContextualAnswer(question, contexts, documentType) {
  const bestContext = contexts[0];
  const contextText = cleanAndFormatText(bestContext.text);
  
  const sentences = contextText.split(/[.!?]+/)
    .filter(s => s.trim().length > 10 && /[a-zA-Z]/.test(s));
  const questionWords = question.toLowerCase().split(/\s+/)
    .filter(word => word.length > 3);
  
  let bestSentence = sentences[0] || contextText.substring(0, 100);
  let maxMatches = 0;
  
  sentences.forEach(sentence => {
    const sentenceLower = sentence.toLowerCase();
    const matches = questionWords.filter(word => 
      sentenceLower.includes(word)
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
  
  // Show document sources for debugging
  const uniqueSources = [...new Set(hits.map(h => path.basename(h.source)))];
  console.log(`📄 Documents: ${uniqueSources.join(', ')}`);
  
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
