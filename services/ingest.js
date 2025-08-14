import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import Chunk from '../models/Chunk.js';
import { embedTexts } from './embedding.js';
import { chunkText } from './chunk.js';
import canvas from 'canvas';
const { createCanvas, Image, ImageData, Path2D } = canvas;

// Set up global objects for PDF.js
global.Image = Image;
global.ImageData = ImageData;
global.Path2D = Path2D;
global.HTMLCanvasElement = createCanvas(1, 1).constructor;
global.CanvasRenderingContext2D = createCanvas(1, 1).getContext('2d').constructor;

// Custom Node Canvas Factory for PDF.js
class NodeCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) {
      throw new Error('Invalid canvas size');
    }
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    if (!canvasAndContext.canvas) {
      throw new Error('Canvas is not specified');
    }
    if (width <= 0 || height <= 0) {
      throw new Error('Invalid canvas size');
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) {
      return; // Already destroyed or invalid
    }
    // Zeroing dimensions helps free memory
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function ocrBuffer(buf) {
  const { data: { text } } = await Tesseract.recognize(buf, 'eng', { logger: () => {} });
  return text || '';
}

function classifyKind(textLower) {
  const words = ['figure', 'chart', 'axis', 'x-axis', 'y-axis', 'legend', 'graph'];
  return words.some(w => textLower.includes(w)) ? 'chart_ocr' : 'image_ocr';
}

export async function processFileAndIndex(filePath, docId, mimetype, progressCallback) {
  const ext = path.extname(filePath).toLowerCase();
  let records = [];

  try {
    if (mimetype === 'application/pdf' || ext === '.pdf') {
      const pdfBuffer = fs.readFileSync(filePath);

      // Extract plain text
      const data = await pdfParse(pdfBuffer);
      const text = data.text || '';
      records.push(...chunkText(text, { source: filePath, page: null, type: 'text' }));

      // Render pages for OCR
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        useWorkerFetch: false,
        isEvalSupported: false,
        disableWorker: true,
        // Add canvas factory to document options
        canvasFactory: new NodeCanvasFactory()
      });
      
      const pdf = await loadingTask.promise;

      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvasFactory = new NodeCanvasFactory();
        const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
        
        const renderContext = {
          canvasContext: canvasAndContext.context,
          viewport,
          canvasFactory, // Include canvas factory in render context
          background: 'rgba(255,255,255,1)'
        };
        
        await page.render(renderContext).promise;

        const buf = canvasAndContext.canvas.toBuffer('image/png');
        const ocrText = await ocrBuffer(buf);
        if (ocrText.trim()) {
          const kind = classifyKind(ocrText.toLowerCase());
          records.push(...chunkText(ocrText, { source: filePath, page: p, type: kind }));
        }
        
        // Properly destroy canvas resources
        canvasFactory.destroy(canvasAndContext);
      }
    } else {
      // OCR image files
      const buf = fs.readFileSync(filePath);
      const ocrText = await ocrBuffer(buf);
      if (ocrText.trim()) {
        const kind = classifyKind(ocrText.toLowerCase());
        records.push(...chunkText(ocrText, { source: filePath, page: null, type: kind }));
      }
    }

    if (!records.length) return { count: 0 };

    // Embed and save to MongoDB with progress callbacks
    const texts = records.map(r => r.text);
    const vectors = await embedTexts(texts, progressCallback);
    const docs = records.map((r, i) => ({
      ...r,
      docId,
      vector: vectors[i]
    }));

    progressCallback?.('success', '✅', `Ingested ${docs.length} chunks`);
    console.log(`✅ Ingested ${docs.length} chunks.`);
    
    if (vectors.length > 0) {
      progressCallback?.('info', '🔢', `Embedding vector size: ${vectors[0].length}`);
      console.log(`🔢 Embedding vector size: ${vectors[0].length}`);
    }

    await Chunk.insertMany(docs);
    return { count: docs.length };
  } finally {
    // Cleanup uploaded file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        progressCallback?.('success', '🗑️', `Deleted uploaded file: ${path.basename(filePath)}`);
        console.log(`🗑️ Deleted uploaded file: ${filePath}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to delete file: ${filePath}`, err);
      progressCallback?.('error', '⚠️', `Failed to delete file: ${path.basename(filePath)}`);
    }
  }
}
