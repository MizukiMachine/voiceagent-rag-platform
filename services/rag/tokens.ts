import { createServiceToken } from '../../framework/di/ServiceManager';
import type { RagRetriever } from './types';
import type { RagService } from './ragService';

export const ragRetrieverToken = createServiceToken<RagRetriever>('RagRetriever');
export const ragServiceToken = createServiceToken<RagService>('RagService');
