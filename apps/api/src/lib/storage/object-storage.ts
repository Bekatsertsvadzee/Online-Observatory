export type StoredCapture = {
  key: string;
  contentType: string;
  size: number;
};

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredCapture>;
  createSignedReadUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
