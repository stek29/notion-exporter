export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type NotionObject = Record<string, unknown> & {
  id: string;
  object: string;
};

export type RootType = "page" | "database" | "data_source";

export interface RootRecord {
  id: string;
  type: RootType;
}

export interface Counts {
  pages: number;
  databases: number;
  data_sources: number;
  views: number;
  comments: number;
  users: number;
  assets: number;
}

export interface ExportStats extends Counts {
  assets_downloaded: number;
  assets_reused_from_previous: number;
  downloaded_bytes: number;
}

export interface Manifest {
  format_version: number;
  exporter_version: string;
  notion_api_version: string;
  exported_at: string;
  roots: RootRecord[];
  skipped?: string[];
  counts: Counts;
}

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  counts?: Counts;
}
