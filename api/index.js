import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import uploadRoutes from '../routes/uploadRoutes.js';
import queryRoutes from '../routes/queryRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '../uploads');

const app = express();

app.use(cors({
  origin: [
    'https://visual-doc-rag-mern-client.vercel.app',
    'http://localhost:5173'
  ],
  credentials: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-session-id']
}));

app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Created uploads folder:', uploadsDir);
}

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('Mongo connected'))
  .catch(e => console.error('Mongo error', e));

// Routes
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Visual Doc RAG API' });
});

app.use('/api/upload', uploadRoutes);
app.use('/api/query', queryRoutes);

// Export for Vercel (no app.listen needed)
export default app;
