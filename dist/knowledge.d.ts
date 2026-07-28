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
/** Découpe un texte en chunks de ~`size` caractères avec recouvrement
 * `overlap`, en coupant sur des frontières d'espaces pour ne pas casser les
 * mots. Simple et déterministe — suffisant pour du RAG documentaire. */
export declare function chunkText(text: string, size?: number, overlap?: number): string[];
export interface KnowledgeStore {
    /** Stocke des chunks déjà vectorisés. Retourne le nombre inséré. */
    ingest(chunks: KnowledgeChunkInput[]): number;
    /** Recherche les top-k chunks les plus proches d'un vecteur de requête. */
    searchByVector(queryEmbedding: number[], opts?: {
        topK?: number;
        namespace?: string;
        threshold?: number;
    }): SearchResult[];
    /** Liste les chunks (debug / inspection). */
    list(opts?: {
        namespace?: string;
        limit?: number;
    }): SearchResult[];
    /** Supprime les chunks d'une source (ou tout un namespace). Retourne le nb supprimé. */
    remove(opts: {
        sourceId?: string;
        namespace?: string;
    }): number;
    /** Nombre de chunks (optionnellement par namespace). */
    count(namespace?: string): number;
    /** Exporte tout le store en JSON portable (vecteurs en base64). */
    export(): KnowledgeExport;
    /** Importe un export (remplace ou fusionne). Retourne le nb importé. */
    import(data: KnowledgeExport, opts?: {
        replace?: boolean;
    }): number;
    close(): void;
}
export interface KnowledgeExport {
    version: 1;
    chunks: Array<{
        id: string;
        namespace: string;
        sourceId: string | null;
        content: string;
        embedding: string;
        metadata: Record<string, unknown>;
    }>;
}
/** Ouvre (ou crée) le store SQLite de l'agent. */
export declare function openKnowledgeStore(options?: KnowledgeStoreOptions): KnowledgeStore;
//# sourceMappingURL=knowledge.d.ts.map