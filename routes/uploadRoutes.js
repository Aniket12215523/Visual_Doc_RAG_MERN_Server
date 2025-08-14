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

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit to prevent crashes
    files: 3 // Limit number of files
  }
});

// SSE endpoint for real-time progress updates
router.get('/progress/:sessionId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sessionId = req.params.sessionId;
  
  if (!req.app.locals.sseConnections) {
    req.app.locals.sseConnections = {};
  }
  req.app.locals.sseConnections[sessionId] = res;

  res.write(`data: ${JSON.stringify({ 
    type: 'info', 
    emoji: '🔗', 
    message: 'Connected to processing stream' 
  })}\n\n`);

  req.on('close', () => {
    delete req.app.locals.sseConnections[sessionId];
  });
});

function sendProgressUpdate(app, sessionId, type, emoji, message) {
  const connection = app.locals.sseConnections?.[sessionId];
  if (connection) {
    try {
      connection.write(`data: ${JSON.stringify({ type, emoji, message })}\n\n`);
    } catch (error) {
      console.warn('Failed to send SSE update:', error.message);
    }
  }
  console.log(`${emoji} ${message}`);
}

// ✅ CRITICAL FIX: Updated upload endpoint with proper error handling
router.post('/', upload.array('files'), async (req, res) => {
  // ✅ Add timeout protection
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  
  const sessionId = req.headers['x-session-id'] || Date.now().toString();
  
  console.log('📤 Upload endpoint hit');
  console.log('Memory usage:', process.memoryUsage()); // Monitor memory
  console.log('Files received:', req.files);
  
  sendProgressUpdate(req.app, sessionId, 'info', '📤', 'Upload endpoint hit');

  if (!req.files || !req.files.length) {
    sendProgressUpdate(req.app, sessionId, 'error', '❌', 'No files uploaded');
    return res.status(400).json({ ok: false, error: 'No files uploaded' });
  }

  // ✅ Check file sizes
  const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > 10 * 1024 * 1024) { // 10MB total limit
    sendProgressUpdate(req.app, sessionId, 'error', '❌', 'Files too large');
    return res.status(400).json({ ok: false, error: 'Files too large. Max 10MB total.' });
  }

  sendProgressUpdate(req.app, sessionId, 'info', '📄', `Processing ${req.files.length} file(s)`);

  // ✅ WRAP EVERYTHING IN TRY-CATCH
  try {
    const ingested = [];
    
    for (const f of req.files) {
      const docId = `${Date.now()}-${f.originalname}`;
      console.log(`Processing file: ${f.path}`);
      sendProgressUpdate(req.app, sessionId, 'processing', '🔄', `Processing file: ${f.originalname}`);
      
      const progressCallback = (step, current, total, extraInfo = '') => {
        sendProgressUpdate(req.app, sessionId, ...step, current, total, extraInfo);
      };
      
      // ✅ Add individual file processing timeout
      const fileProcessingPromise = processFileAndIndex(f.path, docId, f.mimetype, progressCallback);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('File processing timeout')), 240000); // 4 minutes
      });
      
      const result = await Promise.race([fileProcessingPromise, timeoutPromise]);
      ingested.push({ docId, ...result });
    }

    const totalChunks = ingested.reduce((a, b) => a + (b.count || 0), 0);
    sendProgressUpdate(req.app, sessionId, 'success', '🎉', `Processing complete! Total chunks: ${totalChunks}`);
    
    setTimeout(() => {
      const connection = req.app.locals.sseConnections?.[sessionId];
      if (connection) {
        connection.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        connection.end();
        delete req.app.locals.sseConnections[sessionId];
      }
    }, 1000);

    res.json({ ok: true, ingested });
    
  } catch (error) {
    console.error('❌ Error during ingestion:', error);
    console.error('❌ Stack trace:', error.stack);
    sendProgressUpdate(req.app, sessionId, 'error', '❌', `Error: ${error.message}`);
    
    // ✅ Ensure SSE connection is closed on error
    const connection = req.app.locals.sseConnections?.[sessionId];
    if (connection) {
      try {
        connection.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        connection.end();
      } catch (e) {
        console.warn('Failed to close SSE connection:', e.message);
      }
      delete req.app.locals.sseConnections[sessionId];
    }
    
    // ✅ Send proper error response
    if (!res.headersSent) {
      res.status(500).json({ 
        ok: false, 
        error: error.message || 'Processing failed',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
});

export default router;
