// Déclaration ambient minimale pour `bun:sqlite` (sous-ensemble utilisé par
// knowledge.ts). Évite d'ajouter `bun-types` aux devDependencies : le SDK
// tourne exclusivement sous Bun (dev + prod), `bun:sqlite` est donc toujours
// disponible au runtime. On ne type que ce dont on se sert.
declare module "bun:sqlite" {
  export interface Statement<T = unknown> {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
    run(...params: unknown[]): void;
  }
  export class Database {
    constructor(
      filename?: string,
      options?: { create?: boolean; readonly?: boolean; readwrite?: boolean },
    );
    query<T = unknown>(sql: string): Statement<T>;
    exec(sql: string): void;
    close(): void;
  }
}
