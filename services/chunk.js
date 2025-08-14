export function chunkText(text, { source, page, type='text', maxLen=800, overlap=120 }) {
  const words = text.split(/\s+/);
  const chunks = [];
  let i = 0, idx = 0;
  while (i < words.length) {
    const window = words.slice(i, i+maxLen);
    const ctext = window.join(' ');
    chunks.push({
      source, page, type, text: ctext, metadata: {}
    });
    idx++; i += Math.max(1, maxLen - overlap);
  }
  return chunks;
}

export function chunkTableCSV(csvText, { source, page }) {
  // Split big CSV into row windows
  const rows = csvText.split(/\r?\n/);
  const header = rows.shift() || '';
  const maxRows = 25;
  const chunks = [];
  for (let i=0; i<rows.length; i+=maxRows) {
    const slice = rows.slice(i, i+maxRows);
    const text = `Table snippet:\n${header}\n${slice.join('\n')}`;
    chunks.push({ source, page, type: 'table', text, metadata: { header } });
  }
  return chunks;
}