import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
}

export interface FileProcessingResult {
  savedFiles: string[];
  imageContents: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  textAnnotations: string[];
}

interface ProcessOptions {
  files: SlackFile[];
  sandboxPath: string;
  botToken: string;
}

export async function processFileAttachments(options: ProcessOptions): Promise<FileProcessingResult> {
  const { files, sandboxPath, botToken } = options;
  const result: FileProcessingResult = {
    savedFiles: [],
    imageContents: [],
    textAnnotations: [],
  };

  if (!files || files.length === 0) return result;

  const uploadsDir = join(sandboxPath, "uploads");
  await mkdir(uploadsDir, { recursive: true });

  for (const file of files) {
    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        console.error(`[FileHandler] Failed to download ${file.name}: HTTP ${response.status}`);
        result.textAnnotations.push(`[User uploaded: ${file.name} — failed to download]`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const savePath = join(uploadsDir, file.name);
      await writeFile(savePath, buffer);
      result.savedFiles.push(savePath);

      const isImage = IMAGE_MIMES.has(file.mimetype);
      if (isImage) {
        result.imageContents.push({
          type: "image",
          source: {
            type: "base64",
            media_type: file.mimetype,
            data: buffer.toString("base64"),
          },
        });
        result.textAnnotations.push(
          `[User uploaded: ${file.name} → /uploads/${file.name} (attached as image)]`
        );
      } else {
        result.textAnnotations.push(
          `[User uploaded: ${file.name} → /uploads/${file.name}]`
        );
      }
    } catch (error) {
      console.error(`[FileHandler] Error processing ${file.name}:`, error);
      result.textAnnotations.push(`[User uploaded: ${file.name} — failed to download]`);
    }
  }

  return result;
}
