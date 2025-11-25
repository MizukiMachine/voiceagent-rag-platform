import { NextResponse } from 'next/server';

import { sessionHost, type SessionCommand } from '../../../../../../services/api/bff/sessionHost';
import {
  ImageUploadError,
  persistImage,
} from '../../../../../../services/api/uploads/imageUploadService';
import { sessionCommandSchema } from '../../validators';
import { handleRouteError, requireBffSecret } from '../../utils';

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

export const runtime = 'nodejs';

export async function POST(request: Request, context: RouteParams) {
  try {
    requireBffSecret(request);
    const { sessionId } = await context.params;
    const contentType = request.headers.get('content-type') ?? '';

    const payload =
      contentType.includes('multipart/form-data') || contentType.includes('application/octet-stream')
        ? await buildImageCommandFromFormData(request, sessionId)
        : (sessionCommandSchema.parse(await request.json()) as SessionCommand);

    const status = await sessionHost.handleCommand(sessionId, payload);
    const responseBody: Record<string, any> = { accepted: true, sessionStatus: status };
    if ('imageMetadata' in payload && payload.imageMetadata) {
      responseBody.imageMetadata = payload.imageMetadata;
    }
    return NextResponse.json(responseBody);
  } catch (error) {
    if (error instanceof ImageUploadError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    return handleRouteError(error);
  }
}

async function buildImageCommandFromFormData(request: Request, sessionId: string): Promise<
  SessionCommand & {
    imageMetadata?: {
      mimeType: string;
      size: number;
      storagePath?: string;
      originalName?: string;
    };
  }
> {
  const formData = await request.formData();
  const rawFile = formData.get('file') ?? formData.get('image');
  const text = stringOrNull(formData.get('text')) ?? undefined;
  const triggerResponse = parseBoolean(formData.get('triggerResponse'), true);

  const stored = await persistImage({
    file: rawFile as Blob,
    sessionId,
  });

  return {
    kind: 'input_image',
    data: stored.base64,
    mimeType: stored.mimeType,
    encoding: 'base64',
    text: text ?? `[Image] ${stored.originalName ?? stored.mimeType}`,
    triggerResponse,
    imageMetadata: {
      mimeType: stored.mimeType,
      size: stored.size,
      storagePath: stored.storagePath,
      originalName: stored.originalName,
    },
  };
}

function stringOrNull(value: FormDataEntryValue | null): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function parseBoolean(value: FormDataEntryValue | null, fallback: boolean): boolean {
  const raw = stringOrNull(value);
  if (raw === null) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  return fallback;
}
