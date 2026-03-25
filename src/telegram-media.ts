import fs from 'fs';
import path from 'path';
import https from 'https';

import { logger } from './logger.js';

/**
 * Download a file from the Telegram Bot API to a local path.
 * Uses getFile to resolve the file_path, then fetches the binary.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  destPath: string,
): Promise<void> {
  // Step 1: resolve file path via Bot API
  const fileInfo = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  if (!fileInfo?.ok || !fileInfo.result?.file_path) {
    throw new Error(`getFile failed: ${JSON.stringify(fileInfo)}`);
  }

  // Step 2: download binary
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(fileUrl, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

/**
 * Transcribe an audio file using OpenAI Whisper API.
 * Returns the transcribed text, or null if no API key or on failure.
 */
export async function transcribeVoice(
  filePath: string,
  openaiKey: string,
): Promise<string | null> {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Build multipart form data manually (no external deps)
    const boundary = `----FormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // model field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      ),
    );

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));

    // end
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Whisper API error ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const json = JSON.parse(data);
              resolve(json.text || '');
            } catch {
              reject(new Error(`Invalid Whisper response: ${data}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return result;
  } catch (err) {
    logger.error({ err, filePath }, 'Voice transcription failed');
    return null;
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON: ${data}`));
          }
        });
      })
      .on('error', reject);
  });
}
