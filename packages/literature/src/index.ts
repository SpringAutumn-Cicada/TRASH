import { Cite } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import "@citation-js/plugin-ris";
import { load } from "cheerio";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { LiteratureSearchResult, SourceLocator } from "@trash/protocol";

export interface TextSegment {
  locator: SourceLocator;
  text: string;
}

export interface ParsedSource {
  source_type: "pdf" | "bibtex" | "ris" | "markdown" | "webpage" | "openalex";
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  source_url?: string;
  abstract?: string;
  parse_status: "indexed" | "metadata_only" | "no_text" | "failed";
  import_error?: string;
  segments: TextSegment[];
}

export interface OpenAlexProviderOptions {
  apiKey?: string;
  fetcher?: typeof fetch;
}

export interface LiteratureSearchProvider {
  readonly id: string;
  search(query: string, limit?: number): Promise<LiteratureSearchResult[]>;
}

const MAX_WEB_BYTES = 10 * 1024 * 1024;
const MAX_WEB_REDIRECTS = 4;
const WEB_TIMEOUT_MS = 15_000;

function parseYear(value: unknown): number | undefined {
  const year = typeof value === "number" ? value : Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : undefined;
}

function authorsFromCsl(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((author) => {
    if (typeof author === "string") return author;
    if (!author || typeof author !== "object") return "";
    const record = author as Record<string, unknown>;
    if (typeof record.literal === "string") return record.literal;
    return [record.given, record.family].filter((part): part is string => typeof part === "string").join(" ");
  }).filter(Boolean);
}

function cslYear(value: unknown): number | undefined {
  if (typeof value === "number") return parseYear(value);
  if (value && typeof value === "object") {
    const dateParts = (value as { "date-parts"?: unknown })["date-parts"];
    if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) return parseYear(dateParts[0][0]);
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Document parsing failed";
}

function fallbackTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled source";
}

function paragraphSegments(text: string, url?: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let heading: string | undefined;
  let paragraphIndex = 0;
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    if (/^#{1,6}\s+/.test(block)) {
      heading = block.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    const content = block
      .replace(/^```[^\n]*\n?|```$/gm, "")
      .replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+)/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (content.length < 2) continue;
    paragraphIndex += 1;
    segments.push({ locator: { kind: "paragraph", paragraph_index: paragraphIndex, ...(heading ? { heading } : {}), ...(url ? { url } : {}) }, text: content });
  }
  return segments;
}

function normalizeCslRecord(input: unknown): Omit<ParsedSource, "source_type" | "parse_status" | "segments"> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const title = (Array.isArray(record.title) ? record.title[0] : record.title) ?? record.name;
  if (typeof title !== "string" || !title.trim()) return undefined;
  const abstract = typeof record.abstract === "string" ? record.abstract.trim() : undefined;
  return {
    title: title.trim(),
    authors: authorsFromCsl(record.author),
    ...(cslYear(record.issued ?? record.date) ? { year: cslYear(record.issued ?? record.date) } : {}),
    ...(typeof record.DOI === "string" ? { doi: record.DOI } : {}),
    ...(typeof record.URL === "string" ? { source_url: record.URL } : {}),
    ...(abstract ? { abstract } : {})
  };
}

function reconstructAbstract(index: unknown): string | undefined {
  if (!index || typeof index !== "object" || Array.isArray(index)) return undefined;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    if (Array.isArray(positions)) for (const position of positions) if (Number.isInteger(position)) words.push([position as number, word]);
  }
  const result = words.sort((left, right) => left[0] - right[0]).map((item) => item[1]).join(" ").trim();
  return result || undefined;
}

export class OpenAlexProvider implements LiteratureSearchProvider {
  readonly id = "openalex-works";
  private readonly apiKey?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAlexProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
  }

  async search(query: string, limit = 20): Promise<LiteratureSearchResult[]> {
    const value = query.trim();
    if (value.length < 2) return [];
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", value);
    const resultLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 50)) : 20;
    url.searchParams.set("per_page", String(resultLimit));
    url.searchParams.set("select", "id,title,authorships,publication_year,doi,primary_location,abstract_inverted_index");
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`OPENALEX_HTTP_${response.status}`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("OPENALEX_RESPONSE_INVALID");
    return payload.results.flatMap((entry): LiteratureSearchResult[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const titleValue = record.title ?? record.display_name;
      if (typeof titleValue !== "string" || !titleValue.trim() || typeof record.id !== "string") return [];
      const authorships = Array.isArray(record.authorships) ? record.authorships : [];
      const authors = authorships.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const author = (item as { author?: { display_name?: unknown } }).author;
        return typeof author?.display_name === "string" ? [author.display_name] : [];
      });
      const primary = record.primary_location && typeof record.primary_location === "object" ? record.primary_location as Record<string, unknown> : {};
      const urlValue = primary.landing_page_url ?? primary.pdf_url;
      const doi = typeof record.doi === "string" ? record.doi.replace(/^https?:\/\/doi\.org\//i, "") : undefined;
      return [{
        provider_id: this.id,
        provider_ref: record.id,
        title: titleValue.trim(),
        authors,
        ...(parseYear(record.publication_year) ? { year: parseYear(record.publication_year) } : {}),
        ...(doi ? { doi } : {}),
        ...(typeof urlValue === "string" && /^https?:\/\//.test(urlValue) ? { url: urlValue } : {}),
        ...(reconstructAbstract(record.abstract_inverted_index) ? { abstract: reconstructAbstract(record.abstract_inverted_index) } : {})
      }];
    });
  }
}

export async function parseImportedFile(fileName: string, bytes: Uint8Array): Promise<ParsedSource[]> {
  const extension = fileName.toLowerCase().split(".").at(-1) ?? "";
  if (!["pdf", "bib", "bibtex", "ris", "md", "markdown"].includes(extension)) throw new Error("UNSUPPORTED_FILE_TYPE");
  const fallback = fallbackTitle(fileName);
  try {
    if (extension === "pdf") {
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("PDF_SIGNATURE_INVALID");
      const loadingTask = getDocument({ data: new Uint8Array(bytes) });
      const document = await loadingTask.promise;
      const segments: TextSegment[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ").replace(/\s+/g, " ").trim();
        if (text.length > 1) segments.push({ locator: { kind: "pdf_page", page_number: pageNumber }, text });
      }
      await loadingTask.destroy();
      return [{ source_type: "pdf", title: fallback, authors: [], parse_status: segments.length ? "indexed" : "no_text", segments }];
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (extension === "md" || extension === "markdown") {
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
      const segments = paragraphSegments(text);
      return [{ source_type: "markdown", title, authors: [], parse_status: segments.length ? "indexed" : "no_text", segments }];
    }
    const sourceType = extension === "ris" ? "ris" : "bibtex";
    const records = new Cite(text).data;
    const parsed = (records as unknown[]).map(normalizeCslRecord).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (parsed.length === 0) throw new Error("BIBLIOGRAPHY_CONTAINS_NO_RECORDS");
    return parsed.map((record) => ({
      ...record,
      source_type: sourceType,
      parse_status: record.abstract ? "indexed" : "metadata_only",
      segments: record.abstract ? [{ locator: { kind: "abstract", field: "abstract" }, text: record.abstract }] : []
    }));
  } catch (error) {
    return [{ source_type: extension === "pdf" ? "pdf" : extension === "ris" ? "ris" : extension === "bib" || extension === "bibtex" ? "bibtex" : "markdown", title: fallback, authors: [], parse_status: "failed", import_error: safeErrorMessage(error), segments: [] }];
  }
}

interface PublicAddress { address: string; family: number }
interface WebpageResponse { status: number; headers: IncomingMessage["headers"]; body: Uint8Array }

async function assertPublicUrl(input: URL): Promise<PublicAddress> {
  if (!["http:", "https:"].includes(input.protocol) || input.username || input.password) throw new Error("URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED");
  const host = input.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("URL_HOST_NOT_PUBLIC");
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 }]
    : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    try { return ipaddr.process(address).range() !== "unicast"; } catch { return true; }
  })) throw new Error("URL_HOST_NOT_PUBLIC");
  return addresses[0];
}

function requestPinned(input: URL, address: PublicAddress): Promise<WebpageResponse> {
  return new Promise((resolve, reject) => {
    const request = (input.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: input.protocol,
      hostname: address.address,
      port: input.port || undefined,
      path: `${input.pathname}${input.search}`,
      agent: false,
      ...(input.protocol === "https:" && !ipaddr.isValid(input.hostname) ? { servername: input.hostname } : {}),
      headers: { host: input.host, accept: "text/html,application/xhtml+xml", "accept-encoding": "identity", connection: "close" }
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const headers = response.headers;
        response.resume();
        resolve({ status, headers, body: new Uint8Array() });
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? "0");
      if (declaredLength > MAX_WEB_BYTES) {
        response.destroy();
        reject(new Error("WEBPAGE_TOO_LARGE"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > MAX_WEB_BYTES) {
          response.destroy(new Error("WEBPAGE_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => resolve({ status, headers: response.headers, body: new Uint8Array(Buffer.concat(chunks)) }));
      response.on("error", reject);
    });
    request.setTimeout(WEB_TIMEOUT_MS, () => request.destroy(new Error("WEBPAGE_TIMEOUT")));
    request.on("error", reject);
    request.end();
  });
}

export type WebpageTransport = (url: URL, address: PublicAddress) => Promise<WebpageResponse>;

export async function fetchPublicWebpage(rawUrl: string, transport: WebpageTransport = requestPinned): Promise<{ final_url: string; html: Uint8Array }> {
  let current = new URL(rawUrl);
  for (let redirects = 0; redirects <= MAX_WEB_REDIRECTS; redirects += 1) {
    const address = await assertPublicUrl(current);
    const response = await transport(current, address);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const header = response.headers.location;
      const location = Array.isArray(header) ? header[0] : header;
      if (!location || redirects === MAX_WEB_REDIRECTS) throw new Error("WEBPAGE_REDIRECT_LIMIT");
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`WEBPAGE_HTTP_${response.status}`);
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new Error("WEBPAGE_ENCODING_UNSUPPORTED");
    const mediaType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") throw new Error("WEBPAGE_NOT_HTML");
    return { final_url: current.href, html: response.body };
  }
  throw new Error("WEBPAGE_REDIRECT_LIMIT");
}

export function parseWebpage(html: Uint8Array, url: string): ParsedSource {
  const $ = load(new TextDecoder().decode(html));
  $("script,style,noscript,nav,footer,header,aside,form,svg,canvas").remove();
  const title = $("main h1").first().text().trim() || $("article h1").first().text().trim() || $("title").first().text().trim() || url;
  const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  const segments: TextSegment[] = [];
  let heading: string | undefined;
  let paragraphIndex = 0;
  root.find("h1,h2,h3,h4,h5,h6,p,blockquote").each((_index, element) => {
    const tag = element.tagName.toLowerCase();
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (/^h[1-6]$/.test(tag)) { heading = text; return; }
    if (text.length < 2) return;
    paragraphIndex += 1;
    segments.push({ locator: { kind: "paragraph", paragraph_index: paragraphIndex, ...(heading ? { heading } : {}), url }, text });
  });
  return { source_type: "webpage", title, authors: [], source_url: url, parse_status: segments.length ? "indexed" : "no_text", segments };
}
