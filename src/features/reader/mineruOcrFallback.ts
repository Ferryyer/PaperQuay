import {
  runMineruCloudParse,
  runMineruLightParse,
  type MineruCloudParseOptions,
  type MineruCloudParseResult,
  type MineruStreamStatus,
} from '../../services/desktop';
import {
  parseMineruMarkdownPages,
  parseMineruPages,
} from '../../services/mineru';
import type { MineruPage } from '../../types/reader';

export interface MineruParseWithFallbackResult {
  result: MineruCloudParseResult;
  jsonText: string;
  blockCount: number;
  usedOcr: boolean;
}

export interface MineruParseRunResult {
  result: MineruCloudParseResult;
  text: string;
  pages: MineruPage[];
  blockCount: number;
  usedOcr: boolean;
  mode: 'precise' | 'lightweight';
}

function getMineruJsonText(result: MineruCloudParseResult): string {
  return result.contentJsonText ?? result.middleJsonText ?? '';
}

function countParsedBlocks(jsonText: string): number {
  return parseMineruPages(jsonText).reduce((count, page) => count + page.length, 0);
}

function createEmptyResultError() {
  return new Error('MinerU returned an empty structured result.');
}

function shouldRetryWithOcr(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (!message.trim()) {
    return true;
  }

  return !/(api\s*token|authorization|unauthori[sz]ed|forbidden|http\s*(?:401|403)|upload url|upload failed|zip download|timed?\s*out|timeout)/i.test(
    message,
  );
}

async function runAttempt(
  options: MineruCloudParseOptions,
  usedOcr: boolean,
): Promise<MineruParseWithFallbackResult> {
  const result = await runMineruCloudParse({
    ...options,
    isOcr: usedOcr,
  });
  const jsonText = getMineruJsonText(result);

  if (!jsonText.trim()) {
    throw createEmptyResultError();
  }

  const blockCount = countParsedBlocks(jsonText);

  if (blockCount <= 0) {
    throw createEmptyResultError();
  }

  return {
    result,
    jsonText,
    blockCount,
    usedOcr,
  };
}

export async function runMineruCloudParseWithOcrFallback(
  options: MineruCloudParseOptions,
  onRetry?: () => void,
): Promise<MineruParseWithFallbackResult> {
  try {
    return await runAttempt(options, options.isOcr === true);
  } catch (firstError) {
    if (options.isOcr === true || !shouldRetryWithOcr(firstError)) {
      throw firstError;
    }

    onRetry?.();
    return runAttempt(options, true);
  }
}

function normalizeMineruResult(result: MineruCloudParseResult): {
  text: string;
  pages: MineruPage[];
} {
  const jsonText = getMineruJsonText(result);

  if (jsonText.trim()) {
    try {
      const pages = parseMineruPages(jsonText);

      if (pages.some((page) => page.length > 0)) {
        return { text: jsonText, pages };
      }
    } catch {
      // Not a usable JSON payload; fall through to Markdown.
    }
  }

  const markdownText = result.markdownText ?? '';

  return {
    text: markdownText,
    pages: parseMineruMarkdownPages(markdownText),
  };
}

export function mineruStateMessage(
  state: string,
  l: (zh: string, en: string) => string,
): string {
  switch (state) {
    case 'submitting':
      return l('正在提交解析任务…', 'Submitting parse task...');
    case 'uploading':
      return l('正在上传 PDF…', 'Uploading PDF...');
    case 'waiting-file':
      return l('等待文件上传…', 'Waiting for file upload...');
    case 'pending':
      return l('排队中，等待解析…', 'Queued, waiting to parse...');
    case 'running':
      return l('正在解析…', 'Parsing...');
    case 'converting':
      return l('正在转换格式…', 'Converting format...');
    case 'done':
      return l('解析完成', 'Parsing finished');
    default:
      return l('处理中…', 'Processing...');
  }
}

export async function runMineruParse(
  options: MineruCloudParseOptions,
  onRetry?: () => void,
  onStatus?: (status: MineruStreamStatus) => void,
): Promise<MineruParseRunResult> {
  const hasToken = Boolean(options.apiToken?.trim());

  if (!hasToken) {
    const result = await runMineruLightParse(options, onStatus);
    const { text, pages } = normalizeMineruResult(result);

    return {
      result,
      text,
      pages,
      blockCount: pages.reduce((count, page) => count + page.length, 0),
      usedOcr: false,
      mode: 'lightweight',
    };
  }

  const precise = await runMineruCloudParseWithOcrFallback(options, onRetry);

  return {
    result: precise.result,
    text: precise.jsonText,
    pages: parseMineruPages(precise.jsonText),
    blockCount: precise.blockCount,
    usedOcr: precise.usedOcr,
    mode: 'precise',
  };
}
