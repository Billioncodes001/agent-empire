/**
 * FREE-06: one repository per product. The office's own repository is the built-in default product `office`; anything
 * saved without a productId (workers, queue tasks, consultancy jobs, chief plans) belongs to it.
 */
export const OFFICE_PRODUCT_ID = 'office';

export interface ProductInfo {
  id: string;
  name: string;
  client?: string;
  /** Absolute path of the product's local repository on the office host. */
  dir: string;
  /** owner/name on GitHub, when known (from the origin remote or from creation). */
  github?: string;
  defaultBranch?: string;
  /** office = the host repository (default product); linked = an existing local repo; created = made on GitHub by the CEO. */
  origin: 'office' | 'linked' | 'created';
  private?: boolean;
  createdAt: number;
  createdBy: string;
  /** Optional per-product cap on queue workers busy at once (the global queue limit still applies). */
  maxWorkers?: number;
  /** Live: the folder exists and is a git work tree. */
  present: boolean;
  /** Live: workers currently bound to it, and its unfinished queue tasks. */
  workers: number;
  openTasks: number;
}

export interface ProductsState {
  products: ProductInfo[];
  /** Repository creation throttle (GitHub secondary rate limits). */
  creation: {
    perHour: number;
    usedThisHour: number;
    /** When the next creation is allowed, if it is not allowed now. */
    nextAllowedAt?: number;
    inFlight: boolean;
  };
  /** Where created products are cloned. */
  productsDir: string;
  storageError?: string;
}

/** A repository name as GitHub accepts it, optionally owner/name. Never an option, never a path. */
export function validRepoName(name: string): boolean {
  const parts = name.split('/');
  if (parts.length > 2) return false;
  return parts.every((p) => /^[A-Za-z0-9_.-]{1,100}$/.test(p) && p !== '.' && p !== '..' && !p.startsWith('-'));
}
