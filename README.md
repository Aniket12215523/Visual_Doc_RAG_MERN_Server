# Visual Document Analysis RAG — MERN (Finance Domain)

**Tech**: MongoDB Atlas (Vector Search) + Express/Node + React (Vite) + Tesseract.js OCR + pdf-parse/pdfjs-dist.

## Quick Start (Local)

### 1) Backend
```bash
cd server
npm i
npm run dev
```

Create a **Vector Search Index** in **MongoDB Atlas** on collection `chunks`:
```json
{
  "fields": [
    {
      "type": "vector",
      "path": "vector",
      "numDimensions": 1536,
      "similarity": "cosine"
    }
  ]
}
```
Name it: `vector_index` (matches code).

### 2) Frontend
```bash
cd client
npm i
npm run dev
```

Open the URL from Vite (usually http://localhost:5173).

## API
- `POST /api/upload` (multipart form) => `files[]`: PDFs/Images. Ingests, OCRs, chunks, embeds, writes to Mongo.
- `POST /api/query` => `{ question, topK }` returns `{ answer, contexts[] }`

## Notes
- Embeddings use **HuggingFace transformers** (`text-embedding-dimenssion - 384 ).
- OCR via **Tesseract.js** (CPU). For heavy PDFs, ingestion will take longer — consider background jobs.
- Table extraction is best-effort via OCR/text chunking; charts are handled via OCR and heuristic classification.

## Deployment
- **Server**: Render/ Railway/ Fly.io. Set env vars and build. Ensure your Atlas vector index exists.
- **Client**: Vercel/Netlify. Set `VITE_API_URL` to your server base URL.