// Bump when a parser starts producing new or reshaped data, so data parsed by an
// older version is parsed again even though the PDF itself hasn't changed: the
// CLI's SQLite index (db.ts) and the web app's saved book (web/book.ts) both
// check it. Pure, so the browser can import it.
export const INDEX_VERSION = 7;
