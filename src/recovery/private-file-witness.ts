/** Private byte/stat proof joined with rollout evidence; never serialized in public state. */
export interface PrivateFileWitness {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
  maxBytes: number;
}
