import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { pdfjs } from 'react-pdf';
import { useLocaleText } from '../../../i18n/uiLanguage';
import { buildPdfJsDocumentInit } from '../../pdf/pdfDocumentSource';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const covers = new Map<string, string>();
const MAX_CACHED_COVERS = 80;

interface PaperPdfCoverProps {
  pdfPath: string | null;
  revision: string;
}

export default function PaperPdfCover({ pdfPath, revision }: PaperPdfCoverProps) {
  const l = useLocaleText();
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const cacheKey = pdfPath ? `${pdfPath}\0${revision}` : '';
  const [cover, setCover] = useState<string | null>(() => covers.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCover(covers.get(cacheKey) ?? null);
    setFailed(false);
  }, [cacheKey]);

  useEffect(() => {
    if (!pdfPath || visible) return;
    const element = rootRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisible(true);
    }, { rootMargin: '240px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pdfPath, visible]);

  useEffect(() => {
    if (!visible || !pdfPath || covers.has(cacheKey)) return;
    let cancelled = false;
    const loadingTask = pdfjs.getDocument(buildPdfJsDocumentInit({ kind: 'local-path', path: pdfPath }, null) as any);
    let document: Awaited<typeof loadingTask.promise> | null = null;

    void (async () => {
      try {
        document = await loadingTask.promise;
        if (cancelled) return;
        const page = await document.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 600 / base.width });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        if (cancelled) return;
        const image = canvas.toDataURL('image/jpeg', 0.78);
        covers.set(cacheKey, image);
        if (covers.size > MAX_CACHED_COVERS) covers.delete(covers.keys().next().value!);
        setCover(image);
        page.cleanup();
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (document) await document.destroy().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      if (!document) void loadingTask.destroy();
    };
  }, [cacheKey, pdfPath, visible]);

  return (
    <div ref={rootRef} className="relative flex h-40 shrink-0 items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-800">
      {cover ? (
        <img src={cover} alt={l('PDF 首页缩略图', 'PDF first-page thumbnail')} className="h-full w-full object-cover object-top" />
      ) : (
        <div className="flex flex-col items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <FileText className="h-7 w-7" strokeWidth={1.5} />
          <span>{!pdfPath ? l('缺少 PDF', 'No PDF') : failed ? l('无法预览 PDF', 'Preview unavailable') : l('正在生成预览…', 'Generating preview...')}</span>
        </div>
      )}
    </div>
  );
}
