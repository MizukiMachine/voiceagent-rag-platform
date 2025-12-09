import path from 'node:path';

export type GeminiFileSearchConfig = {
  projectId: string;
  location: string;
  storeId: string;
  servingConfigId: string;
  storeKind: 'fileStores' | 'dataStores';
  apiEndpoint: string;
  apiVersion: 'v1' | 'v1beta';
  defaultTopK: number;
  serviceAccountKeyPath?: string;
};

type Env = NodeJS.ProcessEnv;

const DEFAULT_ENDPOINT = 'discoveryengine.googleapis.com';
const DEFAULT_LOCATION = 'global';
const DEFAULT_STORE_KIND: GeminiFileSearchConfig['storeKind'] = 'fileStores';
const DEFAULT_SERVING_CONFIG_ID = 'default_serving_config';

export function loadGeminiFileSearchConfigFromEnv(env: Env = process.env): GeminiFileSearchConfig | null {
  const projectId = env.FILE_SEARCH_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT;
  const location = env.FILE_SEARCH_LOCATION ?? DEFAULT_LOCATION;
  const storeId = env.FILE_SEARCH_DATA_STORE_ID ?? extractStoreId(env.GEMINI_FILE_SEARCH_DATA_STORE);
  const servingConfigId = env.FILE_SEARCH_SERVING_CONFIG_ID ?? DEFAULT_SERVING_CONFIG_ID;

  if (!projectId || !storeId) {
    return null;
  }

  const storeKind = (env.FILE_SEARCH_STORE_KIND as GeminiFileSearchConfig['storeKind']) ?? DEFAULT_STORE_KIND;
  const apiEndpoint = env.FILE_SEARCH_API_ENDPOINT ?? DEFAULT_ENDPOINT;
  const apiVersion = (env.FILE_SEARCH_API_VERSION as GeminiFileSearchConfig['apiVersion']) ?? 'v1beta';
  const defaultTopK = Number(env.FILE_SEARCH_DEFAULT_TOP_K ?? '') || 5;
  const serviceAccountKeyPath = resolveKeyPath(env.FILE_SEARCH_SA_KEY_PATH ?? env.GOOGLE_APPLICATION_CREDENTIALS);

  return {
    projectId,
    location,
    storeId,
    servingConfigId,
    storeKind,
    apiEndpoint,
    apiVersion,
    defaultTopK,
    serviceAccountKeyPath,
  };
}

export function buildServingConfigResource(config: GeminiFileSearchConfig): string {
  // Allow storeId to already contain a full resource path.
  if (config.storeId.startsWith('projects/')) {
    return `${stripTrailingSlash(config.storeId)}/servingConfigs/${config.servingConfigId}`;
  }

  return [
    'projects',
    config.projectId,
    'locations',
    config.location,
    config.storeKind,
    config.storeId,
    'servingConfigs',
    config.servingConfigId,
  ].join('/');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function extractStoreId(resource?: string): string | undefined {
  if (!resource) return undefined;
  const match = resource.match(/(?:fileStores|dataStores)\/([^/]+)/);
  if (match?.[1]) return match[1];
  const parts = resource.split('/');
  return parts[parts.length - 1];
}

function resolveKeyPath(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return path.resolve(raw);
  }
  return raw;
}
