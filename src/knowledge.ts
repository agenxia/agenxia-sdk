// Knowledge store agent-side — RAG sans dépendance externe ni extension native.
//
// Les vecteurs vivent dans un fichier SQLite (`bun:sqlite`) sur le disque de
// l'agent, JAMAIS dans la DB plateforme (qui ne doit pas contenir de data
// client) ni sur GitHub. La similarité cosinus est calculée en JS sur les
// chunks de l'agent — suffisant pour une KB mono-agent, et portable partout où
// Bun tourne (daemon local persistant, conteneur Coolify éphémère assumé).
//
// Persistance : le fichier survit là où le disque survit (daemon local, agent
// auto-hébergé). Sur l'instance mutualisée de la plateforme le disque est
// éphémère — c'est assumé : un client qui veut de la durabilité clone/déploie
// son propre agent. La portabilité passe par export()/import().
//
// Les embeddings sont produits hors de ce store (via le proxy plateforme
// `llm.embed()`), puis fournis ici. Le store ne fait que stocker/chercher des
// vecteurs — il n'appelle aucun LLM lui-même.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface KnowledgeChunkInput {
  /** Texte du chunk (retourné tel quel au retrieval). */
  content: string;
  /** Vecteur d'embedding du chunk. */
  embedding: number[];
  /** Identifiant de la source (document, URL…) pour grouper/supprimer. */
  sourceId?: string;
  /** Cloison logique (multi-tenant dans un même agent). Défaut "default". */
  namespace?: string;
  /** Métadonnées libres (titre, tags, position…). */
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  sourceId: string | null;
  metadata: Record<string, unknown>;
}

export interface KnowledgeStoreOptions {
  /** Chemin du fichier SQLite. Défaut : `${AGENT_DATA_DIR||cwd/data}/knowledge.db`. */
  path?: string;
}

interface ChunkRow {
  id: string;
  content: string;
  embedding: Uint8Array;
  source_id: string | null;
  metadata: string | null;
}

function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const dir = process.env.AGENT_DATA_DIR || join(process.cwd(), "data");
  return join(dir, "knowledge.db");
}

function vectorToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

function blobToVector(blob: Uint8Array): Float32Array {
  // Réaligne sur la mémoire exacte du BLOB (byteOffset peut être non nul).
  return new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Découpe un texte en chunks de ~`size` caractères avec recouvrement
 * `overlap`, en coupant sur des frontières d'espaces pour ne pas casser les
 * mots. Simple et déterministe — suffisant pour du RAG documentaire. */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Recule jusqu'au dernier espace pour ne pas couper un mot.
      const lastSpace = clean.lastIndexOf(" ", end);
      if (lastSpace > start + size * 0.5) end = lastSpace;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export interface KnowledgeStore {
  /** Stocke des chunks déjà vectorisés. Retourne le nombre inséré. */
  ingest(chunks: KnowledgeChunkInput[]): number;
  /** Recherche les top-k chunks les plus proches d'un vecteur de requête. */
  searchByVector(
    queryEmbedding: number[],
    opts?: { topK?: number; namespace?: string; threshold?: number },
  ): SearchResult[];
  /** Liste les chunks (debug / inspection). */
  list(opts?: { namespace?: string; limit?: number }): SearchResult[];
  /** Supprime les chunks d'une source (ou tout un namespace). Retourne le nb supprimé. */
  remove(opts: { sourceId?: string; namespace?: string }): number;
  /** Nombre de chunks (optionnellement par namespace). */
  count(namespace?: string): number;
  /** Exporte tout le store en JSON portable (vecteurs en base64). */
  export(): KnowledgeExport;
  /** Importe un export (remplace ou fusionne). Retourne le nb importé. */
  import(data: KnowledgeExport, opts?: { replace?: boolean }): number;
  close(): void;
}

export interface KnowledgeExport {
  version: 1;
  chunks: Array<{
    id: string;
    namespace: string;
    sourceId: string | null;
    content: string;
    embedding: string; // base64 des octets Float32
    metadata: Record<string, unknown>;
  }>;
}

/** Ouvre (ou crée) le store SQLite de l'agent. */
export function openKnowledgeStore(
  options: KnowledgeStoreOptions = {},
): KnowledgeStore {
  const dbPath = resolveDbPath(options.path);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk (
      id         TEXT PRIMARY KEY,
      namespace  TEXT NOT NULL DEFAULT 'default',
      source_id  TEXT,
      content    TEXT NOT NULL,
      embedding  BLOB NOT NULL,
      metadata   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_ns ON chunk (namespace);
    CREATE INDEX IF NOT EXISTS idx_chunk_src ON chunk (source_id);
  `);

  const rowToResult = (row: ChunkRow, score: number): SearchResult => ({
    id: row.id,
    content: row.content,
    score,
    sourceId: row.source_id,
    metadata: row.metadata ? safeParse(row.metadata) : {},
  });

  return {
    ingest(chunks) {
      if (!Array.isArray(chunks) || chunks.length === 0) return 0;
      const insert = db.query(
        `INSERT INTO chunk (id, namespace, source_id, content, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      db.exec("BEGIN");
      try {
        for (const c of chunks) {
          if (!c?.content || !Array.isArray(c.embedding)) continue;
          insert.run(
            crypto.randomUUID(),
            c.namespace || "default",
            c.sourceId ?? null,
            c.content,
            vectorToBlob(c.embedding),
            c.metadata ? JSON.stringify(c.metadata) : null,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return chunks.length;
    },

    searchByVector(queryEmbedding, opts = {}) {
      const ns = opts.namespace || "default";
      const topK = opts.topK ?? 5;
      const threshold = opts.threshold ?? 0;
      const q = new Float32Array(queryEmbedding);
      const rows = db
        .query<ChunkRow>(
          `SELECT id, content, embedding, source_id, metadata FROM chunk WHERE namespace = ?`,
        )
        .all(ns);
      const scored = rows
        .map((row) => ({ row, score: cosine(q, blobToVector(row.embedding)) }))
        .filter((s) => s.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return scored.map((s) => rowToResult(s.row, s.score));
    },

    list(opts = {}) {
      const limit = opts.limit ?? 100;
      const rows = opts.namespace
        ? db
            .query<ChunkRow>(
              `SELECT id, content, embedding, source_id, metadata FROM chunk WHERE namespace = ? LIMIT ?`,
            )
            .all(opts.namespace, limit)
        : db
            .query<ChunkRow>(
              `SELECT id, content, embedding, source_id, metadata FROM chunk LIMIT ?`,
            )
            .all(limit);
      return rows.map((row) => rowToResult(row, 0));
    },

    remove(opts) {
      if (opts.sourceId) {
        const ns = opts.namespace || "default";
        const before = this.count(ns);
        db.query(`DELETE FROM chunk WHERE source_id = ? AND namespace = ?`).run(
          opts.sourceId,
          ns,
        );
        return before - this.count(ns);
      }
      if (opts.namespace) {
        const before = this.count(opts.namespace);
        db.query(`DELETE FROM chunk WHERE namespace = ?`).run(opts.namespace);
        return before - this.count(opts.namespace);
      }
      return 0;
    },

    count(namespace) {
      const row = namespace
        ? db
            .query<{
              n: number;
            }>(`SELECT COUNT(*) AS n FROM chunk WHERE namespace = ?`)
            .get(namespace)
        : db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk`).get();
      return row?.n ?? 0;
    },

    export() {
      const rows = db
        .query<
          ChunkRow & { namespace: string }
        >(`SELECT id, namespace, content, embedding, source_id, metadata FROM chunk`)
        .all();
      return {
        version: 1,
        chunks: rows.map((row) => ({
          id: row.id,
          namespace: row.namespace,
          sourceId: row.source_id,
          content: row.content,
          embedding: Buffer.from(row.embedding).toString("base64"),
          metadata: row.metadata ? safeParse(row.metadata) : {},
        })),
      };
    },

    import(data, opts = {}) {
      if (!data || data.version !== 1 || !Array.isArray(data.chunks)) return 0;
      if (opts.replace) db.exec("DELETE FROM chunk");
      const insert = db.query(
        `INSERT OR REPLACE INTO chunk (id, namespace, source_id, content, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      db.exec("BEGIN");
      try {
        for (const c of data.chunks) {
          insert.run(
            c.id || crypto.randomUUID(),
            c.namespace || "default",
            c.sourceId ?? null,
            c.content,
            new Uint8Array(Buffer.from(c.embedding, "base64")),
            c.metadata ? JSON.stringify(c.metadata) : null,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return data.chunks.length;
    },

    close() {
      db.close();
    },
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
