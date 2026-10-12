export function inferPdfPublicationYear(firstPageText: string, filePath: string, metadataDate: string): string | null {
  const arxivId = firstPageText.match(/\barXiv:\s*(\d{2})(0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?\b/i)
    ?? filePath.match(/(?:^|[-_/\\])(\d{2})(0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?\.pdf$/i);
  if (arxivId) {
    const year = 2000 + Number(arxivId[1]);
    if (year >= 2007 && year <= new Date().getFullYear() + 1) return String(year);
  }

  const match = metadataDate.match(/(?:D:)?((?:19|20)\d{2})/);
  return match ? match[1] : null;
}
