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

// Fast OCR function optimized for speed
async function ocrBuffer(buf, isChart = false) {
  try {
    // Get image metadata first to make smart decisions
    const image = sharp(buf);
    const metadata = await image.metadata();
    
    // Determine optimal size (don't go over 1500px for speed)
    let targetWidth = Math.min(metadata.width || 1000, 1500);
    let targetHeight = Math.min(metadata.height || 1000, 1500);
    
    // Single, optimized preprocessing pipeline
    const processedBuffer = await image
      .resize(targetWidth, targetHeight, { 
        fit: 'inside',
        withoutEnlargement: true 
      })
      .greyscale() // Convert to greyscale for faster processing
      .normalize() // Auto-adjust contrast
      .sharpen({ sigma: 1.0 }) // Light sharpening
      .png({ quality: 90 }) // Use PNG for better OCR
      .toBuffer();

    console.log(`OCR processing image: ${targetWidth}x${targetHeight}px`);

    // Single, optimized Tesseract configuration
    const { data: { text, confidence } } = await Tesseract.recognize(processedBuffer, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode: isChart ? Tesseract.PSM.AUTO : Tesseract.PSM.SINGLE_BLOCK,
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
      // Speed optimizations
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?@()[]{}:;-_/\\%$#&+=*"\'',
      preserve_interword_spaces: 1
    });

    console.log(`OCR completed with ${confidence}% confidence`);
    
    // Quick text cleaning (much simpler than before)
    const cleanedText = text
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,!?@()-:\/&%]/g, ' ')
      .trim();
    
    return cleanedText;
    
  } catch (error) {
    console.warn('Fast OCR failed, using basic fallback:', error.message);
    
    // Ultra-simple fallback
    try {
      const { data: { text } } = await Tesseract.recognize(buf, 'eng', {
        logger: () => {},
        tessedit_pageseg_mode: Tesseract.PSM.AUTO
      });
      return text?.replace(/\s+/g, ' ').trim() || '';
    } catch (fallbackError) {
      console.error('All OCR attempts failed:', fallbackError);
      return '';
    }
  }
}

function classifyKind(textLower) {
  const chartWords = ['figure', 'chart', 'axis', 'x-axis', 'y-axis', 'legend', 'graph', 'plot', 'data', 'trend'];
  const certWords = ['certificate', 'certification', 'awarded', 'presented', 'issued', 'diploma', 'achievement'];
  const tableWords = ['table', 'row', 'column', 'header', 'total', 'sum'];
  
  if (chartWords.some(w => textLower.includes(w))) return 'chart_ocr';
  if (certWords.some(w => textLower.includes(w))) return 'certificate_ocr';
  if (tableWords.some(w => textLower.includes(w))) return 'table_ocr';
  return 'image_ocr';
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
      if (text.trim()) {
        records.push(...chunkText(text, { source: filePath, page: null, type: 'text' }));
      }

      // Render pages for OCR
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        useWorkerFetch: false,
        isEvalSupported: false,
        disableWorker: true,
        canvasFactory: new NodeCanvasFactory()
      });
      
      const pdf = await loadingTask.promise;

      for (let p = 1; p <= pdf.numPages; p++) {
        try {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 2.0 }); // Reduced from 2.5 to 2.0
          const canvasFactory = new NodeCanvasFactory();
          const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
          
          const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
            canvasFactory,
            background: 'rgba(255,255,255,1)'
          };
          
          await page.render(renderContext).promise;

          const buf = canvasAndContext.canvas.toBuffer('image/png');
          
          // Determine if this might be a chart page
          const isChart = text.toLowerCase().includes('chart') || text.toLowerCase().includes('graph');
          const ocrText = await ocrBuffer(buf, isChart);
          
          if (ocrText.trim() && ocrText.length > 5) { // Only save meaningful text
            const kind = classifyKind(ocrText.toLowerCase());
            records.push(...chunkText(ocrText, { source: filePath, page: p, type: kind }));
          }
          
          canvasFactory.destroy(canvasAndContext);
        } catch (pageError) {
          console.warn(`Failed to process page ${p}:`, pageError.message);
          progressCallback?.('error', '⚠️', `Failed to process page ${p}: ${pageError.message}`);
          continue; // Skip this page and continue with others
        }
      }
    } else {
      // Direct image OCR processing
      const buf = fs.readFileSync(filePath);
      const isChart = path.basename(filePath).toLowerCase().includes('chart');
      const ocrText = await ocrBuffer(buf, isChart);
      
      if (ocrText.trim() && ocrText.length > 5) {
        const kind = classifyKind(ocrText.toLowerCase());
        records.push(...chunkText(ocrText, { source: filePath, page: null, type: kind }));
      }
    }

    if (!records.length) return { count: 0 };

    // Filter out very short or meaningless chunks
    const meaningfulRecords = records.filter(record => 
      record.text && 
      record.text.trim().length > 10 && 
      !/^[^a-zA-Z]*$/.test(record.text) // Not just symbols/numbers
    );

    if (!meaningfulRecords.length) return { count: 0 };

    // Embed and save to MongoDB with progress callbacks
    const texts = meaningfulRecords.map(r => r.text);
    const vectors = await embedTexts(texts, progressCallback);
    const docs = meaningfulRecords.map((r, i) => ({
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
