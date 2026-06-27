export interface SavedDocumentSource {
  saved: boolean;
  path?: string;
  metadataPath?: string;
  bytes?: number;
}

export async function saveDocumentSource(input: {
  sourceId: string;
  content?: string;
  metadata?: Record<string, unknown>;
}): Promise<SavedDocumentSource> {
  void input;
  throw new Error('filesystem_storage_disabled');
}
