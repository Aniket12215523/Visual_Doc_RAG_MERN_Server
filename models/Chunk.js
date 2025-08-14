import mongoose from 'mongoose';

const ChunkSchema = new mongoose.Schema({
  docId: String,
  source: String,
  page: Number,
  type: { type: String, default: 'text' }, // text | table | image_ocr | chart_ocr | ocr
  text: { type: String, index: true },
  vector: { type: [Number], index: false }, // Atlas Vector index created via CLI/UI
  metadata: { type: Object, default: {} }
}, { timestamps: true });


export default mongoose.model('Chunk', ChunkSchema);