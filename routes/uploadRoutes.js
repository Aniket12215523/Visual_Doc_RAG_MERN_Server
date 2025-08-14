import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { processFileAndIndex } from '../services/ingest.js';
import fs from 'fs';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '../uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${unique}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

// SSE endpoint for real-time progress updates
router.get('/progress/:sessionId', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sessionId = req.params.sessionId;
  
  // Store SSE connection
  if (!req.app.locals.sseConnections) {
    req.app.locals.sseConnections = {};
  }
  req.app.locals.sseConnections[sessionId] = res;

  // Send connection confirmation
  res.write(`data: ${JSON.stringify({ 
    type: 'info', 
    emoji: '🔗', 
    message: 'Connected to processing stream' 
  })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    delete req.app.locals.sseConnections[sessionId];
  });
});

// Helper function to send SSE updates
function sendProgressUpdate(app, sessionId, type, emoji, message) {
  const connection = app.locals.sseConnections?.[sessionId];
  if (connection) {
    try {
      connection.write(`data: ${JSON.stringify({ type, emoji, message })}\n\n`);
    } catch (error) {
      console.warn('Failed to send SSE update:', error.message);
    }
  }
  // Always log to console as well
  console.log(`${emoji} ${message}`);
}

// Updated upload endpoint with real-time progress
router.post('/', upload.array('files'), async (req, res) => {
  const sessionId = req.headers['x-session-id'] || Date.now().toString();
  
  console.log('📤 Upload endpoint hit');
  console.log('Files received:', req.files);
  
  sendProgressUpdate(req.app, sessionId, 'info', '📤', 'Upload endpoint hit');

  if (!req.files || !req.files.length) {
    sendProgressUpdate(req.app, sessionId, 'error', '❌', 'No files uploaded');
    return res.status(400).json({ ok: false, error: 'No files uploaded' });
  }

  sendProgressUpdate(req.app, sessionId, 'info', '📄', `Processing ${req.files.length} file(s)`);

  try {
    const ingested = [];
    
    for (const f of req.files) {
      const docId = `${Date.now()}-${f.originalname}`;
      console.log(`Processing file: ${f.path}`);
      sendProgressUpdate(req.app, sessionId, 'processing', '🔄', `Processing file: ${f.originalname}`);
      
      // Create progress callback for this file
      const progressCallback = (step, current, total, extraInfo = '') => {
        sendProgressUpdate(req.app, sessionId, ...step, current, total, extraInfo);
      };
      
      const result = await processFileAndIndex(f.path, docId, f.mimetype, progressCallback);
      ingested.push({ docId, ...result });
    }

    const totalChunks = ingested.reduce((a, b) => a + (b.count || 0), 0);
    sendProgressUpdate(req.app, sessionId, 'success', '🎉', `Processing complete! Total chunks: ${totalChunks}`);
    
    // Close SSE connection after a delay
    setTimeout(() => {
      const connection = req.app.locals.sseConnections?.[sessionId];
      if (connection) {
        connection.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        connection.end();
        delete req.app.locals.sseConnections[sessionId];
      }
    }, 1000);

    res.json({ ok: true, ingested });
    
  } catch (e) {
    console.error('❌ Error during ingestion:', e);
    sendProgressUpdate(req.app, sessionId, 'error', '❌', `Error during ingestion: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
