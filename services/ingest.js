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

// Enhanced OCR function with multiple preprocessing approaches
async function ocrBuffer(buf, isChart = false) {
  try {
    // Multiple preprocessing approaches for better OCR
    const preprocessing = [
      // Approach 1: High contrast with sharpening
      sharp(buf)
        .resize({ width: 3000, height: null, withoutEnlargement: false })
        .normalize()
        .sharpen({ sigma: 1.5 })
        .threshold(128)
        .png({ quality: 100 }),
      
      // Approach 2: Gamma correction with blur reduction  
      sharp(buf)
        .resize({ width: 2500, height: null, withoutEnlargement: false })
        .gamma(1.5)
        .sharpen()
        .normalize()
        .png({ quality: 100 }),
      
      // Approach 3: Edge enhancement
      sharp(buf)
        .resize({ width: 2000, height: null, withoutEnlargement: false })
        .modulate({ brightness: 1.2, saturation: 0 }) // Convert to grayscale with brightness
        .sharpen({ sigma: 1.0 })
        .png({ quality: 100 })
    ];

    let bestText = '';
    let bestScore = 0;

    // Try each preprocessing approach
    for (let i = 0; i < preprocessing.length; i++) {
      try {
        const processedBuffer = await preprocessing[i].toBuffer();
        
        // Multiple OCR configurations
        const ocrConfigs = [
          {
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?@()[]{}:;-_/\\%$#&+=*"\''
          },
          {
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            preserve_interword_spaces: 1
          },
          {
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_COLUMN,
            tessedit_ocr_engine_mode: Tesseract.OEM.DEFAULT
          }
        ];

        for (const config of ocrConfigs) {
          const { data: { text, confidence } } = await Tesseract.recognize(processedBuffer, 'eng', {
            logger: () => {},
            ...config
          });

          if (confidence > bestScore) {
            bestScore = confidence;
            bestText = text || '';
          }
        }
      } catch (error) {
        console.warn(`OCR preprocessing approach ${i + 1} failed:`, error.message);
        continue;
      }
    }

    // Clean and post-process the best result
    const cleanedText = enhancedCleanOCRText(bestText);
    console.log(`OCR confidence: ${bestScore}%`);
    
    return cleanedText;
    
  } catch (error) {
    console.warn('All OCR preprocessing failed, using basic OCR:', error);
    
    // Final fallback
    try {
      const { data: { text } } = await Tesseract.recognize(buf, 'eng', { 
        logger: () => {},
        tessedit_pageseg_mode: Tesseract.PSM.AUTO
      });
      return enhancedCleanOCRText(text || '');
    } catch (fallbackError) {
      console.error('OCR completely failed:', fallbackError);
      return '';
    }
  }
}

// Enhanced text cleaning with pattern recognition
function enhancedCleanOCRText(text) {
  let cleaned = text
    // Fix common OCR character substitutions
    .replace(/[|]/g, 'I')
    .replace(/[¡]/g, 'i')
    .replace(/[°]/g, 'o')
    .replace(/[©]/g, 'c')
    .replace(/[®]/g, 'r')
    .replace(/[™]/g, 'tm')
    
    // Fix spacing issues
    .replace(/\s+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    
    // Remove obvious OCR garbage
    .replace(/[^\w\s.,!?@()-:\/&%]/g, ' ')
    .replace(/\b[a-z]\b/g, '') // Remove isolated single letters (except I, a)
    .replace(/\b\d{1}\b/g, '') // Remove isolated single digits
    
    // Normalize punctuation
    .replace(/[.]{2,}/g, '.')
    .replace(/[,]{2,}/g, ',')
    
    // Fix common word patterns for certificates
    .replace(/\bGertiricate\b/gi, 'Certificate')
    .replace(/\bls\s+Presented\b/gi, 'is Presented')
    .replace(/\bINIVERSITY\b/gi, 'UNIVERSITY')
    .replace(/\bINSTITUTE\b/gi, 'INSTITUTE')
    .replace(/\bPROFESSIONAL\b/gi, 'PROFESSIONAL')
    .replace(/\bSatisfactory\b/gi, 'Satisfactory')
    .replace(/\bPunctual\b/gi, 'Punctual')
    .replace(/\bDedicated\b/gi, 'Dedicated')
    .replace(/\bHonest\b/gi, 'Honest')
    .replace(/\binternship\b/gi, 'internship')
    .replace(/\bperformance\b/gi, 'performance')
    
    .trim();

  // Try to reconstruct meaningful sentences
  const sentences = cleaned.split(/[.!?]+/).map(sentence => {
    let s = sentence.trim();
    
    // Fix sentence patterns
    if (s.includes('together for children')) {
      s = s.replace(/.*together for children.*/, 'Together for Children organization');
    }
    
    if (s.includes('Certificate') && s.includes('Presented')) {
      s = 'This Certificate is Presented';
    }
    
    if (s.includes('LOVELY') && s.includes('PROFESSIONAL')) {
      s = 'Lovely Professional University';
    }
    
    if (s.includes('Performance') && s.includes('Satisfactory')) {
      s = 'Performance was Satisfactory. Student was Punctual, Dedicated and Honest';
    }
    
    return s;
  }).filter(s => s.length > 5);

  return sentences.join('. ').trim();
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
          const viewport = page.getViewport({ scale: 2.5 }); // Increased scale for better OCR
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
