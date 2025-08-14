import express from 'express';
import { queryRAG } from '../services/query.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { question, topK = 5 } = req.body || {};
    const result = await queryRAG(question, topK);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('❌ Query error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
