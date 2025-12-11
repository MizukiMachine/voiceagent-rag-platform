export interface RagSearchParams {
  query: string;
  topK?: number;
  filter?: string;
}

export interface RagRetrieverDocument {
  id: string;
  title?: string;
  uri?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, any>;
}

export interface RagRetrieverResult {
  items: RagRetrieverDocument[];
  tookMs?: number;
}

export interface RagRetriever {
  search(params: RagSearchParams): Promise<RagRetrieverResult>;
}

export interface RagSearchResultItem extends RagRetrieverDocument {
  citeTag: string;
  source: string;
}

export interface RagSearchResult {
  query: string;
  filter?: string;
  topK: number;
  tookMs?: number;
  items: RagSearchResultItem[];
  summary: string;
}
