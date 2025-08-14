/**
 * Some hosts fail building sharp/pdfjs optional deps; ignore failures.
 */
try { console.log('Postinstall noop'); } catch(e) {}