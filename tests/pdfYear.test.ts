import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPdfPublicationYear } from '../src/services/pdfYear.ts';

test('the arXiv identifier on the first page takes precedence over an old PDF creation date', () => {
  assert.equal(
    inferPdfPublicationYear('arXiv:2606.31650v5 [cs.LG] 3 Aug 2026', '/papers/echo.pdf', 'D:20060101000000'),
    '2026',
  );
});

test('an arXiv filename supplies the year when the first page has no date', () => {
  assert.equal(
    inferPdfPublicationYear('', '/papers/paper_abc-2606.31650v5.pdf', ''),
    '2026',
  );
});

test('ordinary PDFs keep their metadata date, or remain undated when absent', () => {
  assert.equal(inferPdfPublicationYear('References 2006', '/papers/review.pdf', 'D:20240305'), '2024');
  assert.equal(inferPdfPublicationYear('References 2006', '/papers/review.pdf', ''), null);
});
