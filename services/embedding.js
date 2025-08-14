import { pipeline } from '@huggingface/transformers';

let embedder = null;

// Initialize the embedding model (only once)
async function initializeEmbedder(progressCallback) {
  if (!embedder) {
    progressCallback?.('processing', '🔄', 'Loading sentence transformer model...');
    console.log('🔄 Loading sentence transformer model...');
    try {
      // Use the exact model ID that works locally
      embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: false, // Use full precision for better quality
      });
      progressCallback?.('success', '✅', 'Sentence transformer model loaded successfully');
      console.log('✅ Sentence transformer model loaded successfully');
    } catch (error) {
      console.error('❌ Failed to load embedding model:', error);
      progressCallback?.('error', '❌', `Failed to load embedding model: ${error.message}`);
      throw error;
    }
  }
  return embedder;
}

export async function embedTexts(texts = [], progressCallback) {
  if (!texts.length) return [];
  
  try {
    const model = await initializeEmbedder(progressCallback);
    const embeddings = [];
    
    progressCallback?.('processing', '🔄', `Processing ${texts.length} texts for embedding...`);
    console.log(`🔄 Processing ${texts.length} texts for embedding...`);
    
    // Process each text individually to avoid memory issues
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      
      // Clean and validate text
      const cleanText = text ? text.trim().substring(0, 512) : '';
      if (!cleanText) {
        // Return zero vector for empty text
        embeddings.push(new Array(384).fill(0));
        continue;
      }
      
      try {
        // Generate embedding for this text
        const result = await model(cleanText, { 
          pooling: 'mean', 
          normalize: true 
        });
        
        // Convert tensor to regular array
        const embedding = Array.from(result.data);
        embeddings.push(embedding);
        
        progressCallback?.('success', '✅', `Generated embedding ${i + 1}/${texts.length}`);
        console.log(`✅ Generated embedding ${i + 1}/${texts.length}`);
        
        // Small delay to prevent overwhelming the system
        if (i < texts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
      } catch (textError) {
        console.error(`❌ Error processing text ${i + 1}:`, textError.message);
        progressCallback?.('error', '❌', `Error processing text ${i + 1}: ${textError.message}`);
        // Return zero vector for failed text
        embeddings.push(new Array(384).fill(0));
      }
    }
    
    progressCallback?.('success', '✅', `Generated ${embeddings.length} embeddings (${embeddings[0]?.length} dimensions each)`);
    console.log(`✅ Generated ${embeddings.length} embeddings (${embeddings[0]?.length} dimensions each)`);
    return embeddings;
    
  } catch (error) {
    console.error('❌ Error in embedding generation:', error);
    progressCallback?.('error', '❌', `Embedding generation failed: ${error.message}`);
    throw new Error(`Embedding generation failed: ${error.message}`);
  }
}

// Utility function to get model info
export function getEmbeddingModelInfo() {
  return {
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    maxTokens: 256,
    type: 'sentence-transformer',
    local: true
  };
}
