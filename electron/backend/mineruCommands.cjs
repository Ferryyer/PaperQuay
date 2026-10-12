const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  MINERU_API_BASE,
  MINERU_STREAM_EVENT,
  cleanString,
  ensureFile,
  fileNameFromPath,
  hashBytes,
  now,
  readRequestJson,
  readZipWithAdm,
} = require('./utils.cjs');

function createMineruCommands(context) {
  const { appPaths } = context;
  let directSessionReady;
  const mineruFetch = context.mineruFetch || (async (url, init) => {
    if (!directSessionReady) {
      const directSession = context.mineruSession || require('electron').session.fromPartition('mineru-direct');
      directSessionReady = directSession.setProxy({ mode: 'direct' })
        .then(() => directSession.fetch.bind(directSession))
        .catch((error) => {
          directSessionReady = null;
          throw error;
        });
    }
    return (await directSessionReady)(url, init);
  });

  return {
    async run_mineru_cloud_parse({ options }) {
      const token = cleanString(options.apiToken);
      if (!token) throw new Error('MinerU API Token cannot be empty');
      const apiBaseUrl = cleanString(options.apiBaseUrl).replace(/\/+$/, '') || MINERU_API_BASE;

      const pdfPath = options.pdfPath;
      await ensureFile(pdfPath);

      const fileName = fileNameFromPath(pdfPath);
      const dataId = `paper_reader_${now()}`;
      const uploadUrlEndpoint = `${apiBaseUrl}/file-urls/batch?enable_formula=${options.enableFormula !== false}&enable_table=${options.enableTable !== false}&language=${encodeURIComponent(options.language || 'ch')}`;
      const uploadEnvelope = await readRequestJson(await mineruFetch(uploadUrlEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{ name: fileName, data_id: dataId }],
          model_version: options.modelVersion || 'vlm',
          is_ocr: options.isOcr === true,
        }),
      }), 'MinerU upload URL');

      if (uploadEnvelope.code !== 0) {
        throw new Error(uploadEnvelope.msg || uploadEnvelope.message || 'MinerU upload URL failed');
      }

      const batchId = uploadEnvelope.data?.batch_id;
      const uploadUrl = uploadEnvelope.data?.file_urls?.[0];
      if (!batchId || !uploadUrl) throw new Error('MinerU did not return an upload URL');

      const putResponse = await mineruFetch(uploadUrl, { method: 'PUT', body: await fsp.readFile(pdfPath) });
      if (!putResponse.ok) throw new Error(`MinerU PDF upload failed: HTTP ${putResponse.status}`);

      const timeoutAt = Date.now() + (options.timeoutSecs ?? 900) * 1000;
      const intervalMs = Math.max(1, options.pollIntervalSecs ?? 5) * 1000;
      let finalResult = null;

      while (Date.now() < timeoutAt) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const statusEnvelope = await readRequestJson(await mineruFetch(`${apiBaseUrl}/extract-results/batch/${batchId}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
        }), 'MinerU status');

        if (statusEnvelope.code !== 0) {
          throw new Error(statusEnvelope.msg || statusEnvelope.message || 'MinerU status failed');
        }

        const results = Array.isArray(statusEnvelope.data?.extract_result)
          ? statusEnvelope.data.extract_result
          : [statusEnvelope.data?.extract_result].filter(Boolean);
        const current = results.find((item) => item.data_id === dataId || item.file_name === fileName) ?? results[0];
        if (!current) continue;

        if (current.state === 'done') {
          finalResult = current;
          break;
        }

        if (current.state === 'failed') {
          throw new Error(current.err_msg || 'MinerU parse failed');
        }
      }

      if (!finalResult?.full_zip_url) {
        throw new Error(`MinerU parse timed out or missed full_zip_url: ${batchId}`);
      }

      const zipResponse = await mineruFetch(finalResult.full_zip_url);
      if (!zipResponse.ok) throw new Error(`MinerU zip download failed: HTTP ${zipResponse.status}`);

      const extractDir = options.extractDir || path.join(
        appPaths.mineruCacheDir,
        `${path.basename(fileName, '.pdf')}-${hashBytes(Buffer.from(dataId)).slice(0, 8)}`,
      );
      const extracted = await readZipWithAdm(Buffer.from(await zipResponse.arrayBuffer()), extractDir);

      return {
        batchId,
        dataId,
        fileName,
        state: finalResult.state,
        fullZipUrl: finalResult.full_zip_url,
        ...extracted,
      };
    },

    // MinerU "Agent 轻量解析" API: no token required (IP rate-limited).
    // Flow: POST /parse/file -> task_id + presigned file_url; PUT the PDF;
    // poll GET /parse/{task_id} until state=done; download markdown_url.
    async run_mineru_light_parse({ options, requestId }, event) {
      const pdfPath = options.pdfPath;
      await ensureFile(pdfPath);

      const sender = event?.sender;
      const sendStatus = (state, message) => {
        if (!sender || sender.isDestroyed()) return;
        sender.send('paperquay:event', MINERU_STREAM_EVENT, {
          requestId,
          kind: 'status',
          state,
          message,
        });
      };

      const stat = await fsp.stat(pdfPath);
      if (stat.size > 10 * 1024 * 1024) {
        throw new Error(
          'MinerU 轻量解析限制单文件 ≤ 10MB，当前文件过大，请改用精准 API（需 Token）。',
        );
      }

      const fileName = fileNameFromPath(pdfPath);
      const apiBaseUrl =
        cleanString(options.apiBaseUrl).replace(/\/+$/, '') || 'https://mineru.net/api/v1/agent';
      const timeoutMs = Math.max(1, (options.timeoutSecs ?? 300) * 1000);
      const timeoutAt = Date.now() + timeoutMs;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      const signal = abortController.signal;
      const request = (url, init = {}) => mineruFetch(url, { ...init, signal });

      try {
        sendStatus('submitting', '正在提交解析任务…');

        const submitEnvelope = await readRequestJson(
          await request(`${apiBaseUrl}/parse/file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_name: fileName,
              language: options.language || 'ch',
              enable_table: options.enableTable !== false,
              is_ocr: options.isOcr === true,
              enable_formula: options.enableFormula !== false,
            }),
          }),
          'MinerU lightweight upload URL',
        );

        if (submitEnvelope.code !== 0) {
          throw new Error(
            submitEnvelope.msg || submitEnvelope.message || 'MinerU lightweight upload URL failed',
          );
        }

        const taskId = submitEnvelope.data?.task_id;
        const fileUrl = submitEnvelope.data?.file_url;
        if (!taskId || !fileUrl) {
          throw new Error('MinerU lightweight API did not return a task id or upload URL');
        }

        sendStatus('uploading', '正在上传 PDF…');

        const putResponse = await request(fileUrl, {
          method: 'PUT',
          body: await fsp.readFile(pdfPath),
        });
        if (!putResponse.ok) {
          throw new Error(`MinerU lightweight PDF upload failed: HTTP ${putResponse.status}`);
        }

        const intervalMs = Math.max(1, options.pollIntervalSecs ?? 2) * 1000;
        let markdownUrl = null;
        let lastState = '';

        while (Date.now() < timeoutAt) {
          await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(intervalMs, Math.max(0, timeoutAt - Date.now())),
          ));
          if (signal.aborted || Date.now() >= timeoutAt) break;
          const statusEnvelope = await readRequestJson(
            await request(`${apiBaseUrl}/parse/${taskId}`, {
              headers: { Accept: '*/*' },
            }),
            'MinerU lightweight status',
          );

          if (statusEnvelope.code !== 0) {
            throw new Error(
              statusEnvelope.msg || statusEnvelope.message || 'MinerU lightweight status failed',
            );
          }

          const data = statusEnvelope.data ?? {};
          lastState = cleanString(data.state);

          if (lastState !== 'done' && lastState !== 'failed') {
            sendStatus(lastState, '');
          }

          if (lastState === 'done') {
            sendStatus('done', '');
            markdownUrl = cleanString(data.markdown_url);
            break;
          }

          if (lastState === 'failed') {
            throw new Error(data.err_msg || 'MinerU lightweight parse failed');
          }
        }

        if (!markdownUrl) {
          throw new Error(`MinerU lightweight parse timed out (state: ${lastState || 'unknown'})`);
        }

        const mdResponse = await request(markdownUrl);
        if (!mdResponse.ok) {
          throw new Error(`MinerU lightweight markdown download failed: HTTP ${mdResponse.status}`);
        }
        const markdownText = await mdResponse.text();

        const extractDir =
          options.extractDir ||
          path.join(
            appPaths.mineruCacheDir,
            `${path.basename(fileName, '.pdf')}-${hashBytes(Buffer.from(taskId)).slice(0, 8)}`,
          );
        await fsp.mkdir(extractDir, { recursive: true });
        const markdownPath = path.join(extractDir, 'full.md');
        await fsp.writeFile(markdownPath, markdownText, 'utf8');

        return {
          batchId: taskId,
          dataId: taskId,
          fileName,
          state: 'done',
          fullZipUrl: markdownUrl,
          contentJsonText: null,
          middleJsonText: null,
          markdownText,
          assetRootDir: extractDir,
          contentJsonPath: null,
          middleJsonPath: null,
          markdownPath,
          zipEntries: ['full.md'],
        };
      } catch (error) {
        if (signal.aborted) {
          throw new Error('MinerU lightweight parse timed out. Please retry or use the precise API.');
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createMineruCommands };
