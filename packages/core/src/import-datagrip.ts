import type { ConnectionConfig } from './types';

/**
 * Imports DataGrip / JetBrains `dataSources.xml` into Custos connections.
 *
 * DataGrip stores connection *metadata* in this XML (name, JDBC URL, driver,
 * sometimes username) but NOT passwords — those live in the OS keychain. That
 * maps cleanly onto Custos: we import everything except the secret, which the
 * user supplies once (and Custos then stores in its own keychain).
 *
 * Dependency-free: DataGrip's file is machine-generated with a stable shape, so
 * a focused extractor is reliable and keeps this off any XML library.
 */

export interface ImportedConnection {
  readonly name: string;
  /** Custos driver id, or null when the source engine isn't supported yet. */
  readonly driverId: string | null;
  /** Non-secret params keyed like the driver's connectionFields. */
  readonly params: Record<string, string | number>;
  readonly readOnly: boolean;
  readonly user?: string;
  readonly jdbcUrl: string;
  /** Non-fatal notes for the user (unsupported engine/auth, missing fields). */
  readonly warnings: string[];
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]!) : undefined;
}

function innerTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? unescapeXml(m[1]!.trim()) : undefined;
}

/** Find a `<property name="X" value="Y"/>` value anywhere in a block. */
function property(block: string, name: string): string | undefined {
  const re = new RegExp(`<property\\s+name="${name}"\\s+value="([^"]*)"`, 'i');
  const m = block.match(re);
  return m ? unescapeXml(m[1]!) : undefined;
}

interface ParsedUrl {
  driverId: string | null;
  params: Record<string, string | number>;
  warnings: string[];
}

/**
 * Map a JDBC URL to a Custos driver + params. Handles the common JetBrains
 * shapes for SQL Server (native + jTDS), MySQL/MariaDB, and flags others.
 */
export function parseJdbcUrl(url: string): ParsedUrl {
  const warnings: string[] = [];

  // SQL Server via jTDS: jdbc:jtds:sqlserver://host:port/database[;props]
  let m = url.match(/^jdbc:jtds:sqlserver:\/\/([^:/;]+)(?::(\d+))?(?:\/([^;?]+))?/i);
  if (m) {
    return {
      driverId: 'azuresql',
      params: cleanParams({ server: m[1], port: m[2] ? Number(m[2]) : 1433, database: m[3], authMode: 'sql' }),
      warnings,
    };
  }

  // SQL Server native: jdbc:sqlserver://host:port;databaseName=db;...  (also ;database=)
  m = url.match(/^jdbc:sqlserver:\/\/([^:/;]+)(?::(\d+))?(.*)$/i);
  if (m) {
    const tail = m[3] ?? '';
    const db = tail.match(/;\s*database(?:Name)?=([^;]+)/i);
    return {
      driverId: 'azuresql',
      params: cleanParams({ server: m[1], port: m[2] ? Number(m[2]) : 1433, database: db?.[1], authMode: 'sql' }),
      warnings,
    };
  }

  // MySQL / MariaDB: jdbc:mysql://host:port/database?params
  m = url.match(/^jdbc:(?:mysql|mariadb):\/\/([^:/?]+)(?::(\d+))?(?:\/([^?]+))?/i);
  if (m) {
    return {
      driverId: 'mysql',
      params: cleanParams({ host: m[1], port: m[2] ? Number(m[2]) : 3306, database: m[3] }),
      warnings,
    };
  }

  // Known-but-unsupported engines: keep the metadata, flag the driver.
  const engine = url.match(/^jdbc:([a-z0-9]+)/i)?.[1]?.toLowerCase();
  warnings.push(`Engine "${engine ?? 'unknown'}" isn't supported by Custos yet — imported for reference only.`);
  return { driverId: null, params: {}, warnings };
}

function cleanParams(obj: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/** Parse a whole `dataSources.xml` document into importable connections. */
export function parseDataGripSources(xml: string): ImportedConnection[] {
  const blocks = xml.match(/<data-source\b[\s\S]*?<\/data-source>/g) ?? [];
  const results: ImportedConnection[] = [];

  for (const block of blocks) {
    const openTag = block.match(/<data-source\b[^>]*>/)?.[0] ?? '';
    const name = attr(openTag, 'name') ?? 'Imported connection';
    const readOnly = attr(openTag, 'read-only') === 'true';
    const jdbcUrl = innerTag(block, 'jdbc-url') ?? '';
    const user = innerTag(block, 'user-name');

    const { driverId, params, warnings } = parseJdbcUrl(jdbcUrl);
    if (user) params['user'] = user;

    // A Windows domain means NTLM auth — map it straight onto the Azure SQL
    // driver's ntlm mode so the connection works after a password is added.
    const domain = property(block, 'DOMAIN') ?? property(block, 'Domain');
    if (domain && driverId === 'azuresql') {
      params['authMode'] = 'ntlm';
      params['domain'] = domain;
      warnings.push(`Windows (NTLM) auth for domain ${domain} — add your password to connect.`);
    } else if (domain) {
      warnings.push(`Windows domain auth (${domain}) isn't supported for this engine.`);
    }
    if (driverId && !user && driverId !== 'azuresql') {
      warnings.push('No username in the file — set it after import.');
    }

    results.push({ name, driverId, params, readOnly, user, jdbcUrl, warnings });
  }
  return results;
}

/** Build a persistable {@link ConnectionConfig} from an imported connection. */
export function toConnectionConfig(imported: ImportedConnection, id: string): ConnectionConfig | null {
  if (!imported.driverId) return null;
  return {
    id,
    name: imported.name,
    driverId: imported.driverId,
    readOnly: imported.readOnly,
    params: imported.params,
  };
}
