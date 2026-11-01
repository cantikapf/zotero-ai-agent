/**
 * External references for a question, restricted to DOI-validated metadata.
 *
 * Two registries, because they index different things: Crossref covers journal articles, book
 * chapters and proceedings; DataCite covers reports, standards, datasets, theses and the
 * organisation-published documents that live on the web without becoming a journal paper.
 * Blogs and opinion venues are rejected on sight (BLOG_HOSTS, OPINION_VENUE) — a DOI is not a
 * quality mark, and a blog post with a DOI is still an opinion piece.
 * The model never invents a reference: it only sees what this module returns, and the numbered
 * list shown to the user is rendered from these records, not from model text.
 */

export interface ExternalSource {
  /** 1-based number the model is told to cite, matching the rendered list. */
  index: number;
  title: string;
  authors: string[];
  year?: number;
  doi: string;
  /** Resolvable landing page. */
  url: string;
  container?: string;
  /** What this is, shown in the citation: `paper`, `report`, `dataset`, `web page`, … */
  kind: string;
  /** Registry's own citation count, used only to rank. DataCite records have none. */
  citedBy?: number;
}

export interface SourceQuery {
  /** Free text: the selection, else the question. */
  query: string;
  limit?: number;
  /** AbortSignal-compatible timeout in ms; a slow registry must never block the answer. */
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

const CROSSREF = "https://api.crossref.org/works";
const DATACITE = "https://api.datacite.org/dois";
const DEFAULT_LIMIT = 5;
const DEFAULT_TIMEOUT = 6000;
const MAX_QUERY_CHARS = 400;

/**
 * Hosts whose DOIs are handed out by blogging platforms. A record from one of these is an
 * opinion post with an identifier attached, not something to cite while reading a paper.
 */
const BLOG_HOSTS = [
  "medium.com", "substack.com", "blogspot.", "wordpress.com", "dev.to", "hashnode.",
  "linkedin.com", "quora.com", "reddit.com", "tumblr.com", "ghost.io", "write.as",
  "wixsite.com", "weebly.com", "notion.site", "telegra.ph", "hackernoon.com",
  "towardsdatascience.com", "psychologytoday.com"
];

/**
 * Venue wording that marks commentary rather than a published source. "opinion" is deliberately
 * absent: real journals carry it in their titles ("Current Opinion in …").
 */
const OPINION_VENUE = /\b(blog|weblog|op-ed|oped|commentary|press release)\b/i;

/** Registry types that are index artefacts or funding records, never a citable source. */
const REJECTED_TYPES = new Set([
  "component", "peerreview", "grant", "journal", "journalissue", "journalvolume", "event"
]);

/**
 * Coarse label per resource type: the reader must see at a glance that a line is a report or a
 * web page rather than assume every reference is a journal article. Keys are compared after
 * normalisation because DataCite spells types `JournalArticle` where Crossref uses
 * `journal-article`.
 */
const KIND_LABELS: Record<string, string> = {
  "journalarticle": "paper",
  "proceedingsarticle": "conference paper",
  "bookchapter": "book chapter",
  monograph: "book",
  "editedbook": "book",
  book: "book",
  dissertation: "thesis",
  "postedcontent": "preprint",
  report: "report",
  standard: "standard",
  dataset: "dataset",
  software: "software",
  collection: "collection",
  text: "document",
  "webresource": "web page",
  other: "document"
};

/** Lowercase, alphanumerics only: `journal-article` and `JournalArticle` both become `journalarticle`. */
function normType(type: unknown): string {
  return clean(type, 40).toLowerCase().replace(/[^a-z]/g, "");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "
};

/** Trims a paper title / author list to something readable, decoding the entities Crossref emits. */
function clean(text: unknown, max = 300): string {
  return String(text ?? "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const point = code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function yearOf(item: any): number | undefined {
  const parts =
    item?.issued?.["date-parts"]?.[0] ||
    item?.published?.["date-parts"]?.[0] ||
    item?.["published-print"]?.["date-parts"]?.[0];
  const year = Number(parts?.[0]);
  return Number.isFinite(year) && year > 1400 ? year : undefined;
}

function authorsOf(item: any): string[] {
  return (item?.author || [])
    .map((a: any) => clean(a?.family || a?.name, 60))
    .filter(Boolean)
    .slice(0, 6);
}

function kindOf(type: unknown): string {
  return KIND_LABELS[normType(type)] || "document";
}

/** True when the record points at a blog or a commentary venue rather than a published source. */
export function isOpinionSource(doi: string, container: string): boolean {
  const haystack = `${doi} ${container}`.toLowerCase();
  if (BLOG_HOSTS.some((host) => haystack.includes(host))) return true;
  // Venue wording only: a scholarly title may legitimately contain "commentary".
  return OPINION_VENUE.test(container);
}

/**
 * Maps one Crossref `/works` record. Returns null when unusable: no DOI (nothing to verify
 * against), no title, an index artefact, or an opinion venue.
 */
export function toSource(item: any, index: number): ExternalSource | null {
  const doi = clean(item?.DOI, 160).toLowerCase();
  const title = clean(Array.isArray(item?.title) ? item.title[0] : item?.title);
  if (!doi || !title) return null;
  const type = normType(item?.type);
  if (REJECTED_TYPES.has(type)) return null;

  const container = clean(
    Array.isArray(item?.["container-title"]) ? item["container-title"][0] : item?.["container-title"],
    120
  );
  if (isOpinionSource(doi, container)) return null;

  return {
    index,
    title,
    authors: authorsOf(item),
    year: yearOf(item),
    doi,
    url: `https://doi.org/${doi}`,
    container: container || undefined,
    kind: kindOf(type),
    citedBy: Number.isFinite(Number(item?.["is-referenced-by-count"]))
      ? Number(item["is-referenced-by-count"])
      : undefined
  };
}

/**
 * Maps one DataCite record. This is what makes "a website that is not a blog" possible: reports,
 * standards, datasets, theses and institutional documents, still under a DOI guarantee.
 */
export function toDataciteSource(record: any, index: number): ExternalSource | null {
  const attributes = record?.attributes || {};
  const doi = clean(attributes.doi || record?.id, 160).toLowerCase();
  const titles: any[] = attributes.titles || [];
  const title = clean(titles.find((t) => !t?.titleType)?.title || titles[0]?.title);
  if (!doi || !title) return null;

  const type = normType(attributes.types?.resourceTypeGeneral);
  if (REJECTED_TYPES.has(type)) return null;

  const container = clean(attributes.publisher, 120);
  if (isOpinionSource(doi, container)) return null;

  const year = Number(attributes.publicationYear);
  return {
    index,
    title,
    authors: (attributes.creators || [])
      .map((c: any) => clean(c?.familyName || c?.name, 60))
      .filter(Boolean)
      .slice(0, 6),
    year: Number.isFinite(year) && year > 1400 ? year : undefined,
    doi,
    url: `https://doi.org/${doi}`,
    container: container || undefined,
    kind: kindOf(type)
  };
}

/**
 * Ranked: Crossref's relevance order is kept, but items with more citations float up among
 * near-ties so a seminal paper beats an obscure one. Stable, so tests can assert order.
 */
export function rankSources(sources: ExternalSource[]): ExternalSource[] {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      // 50-citation buckets keep Crossref's relevance dominant.
      const bucket = Math.floor((b.s.citedBy || 0) / 50) - Math.floor((a.s.citedBy || 0) / 50);
      return bucket || a.i - b.i;
    })
    .map(({ s }, i) => ({ ...s, index: i + 1 }));
}

/** Drops a DOI both registries know, keeping the first (Crossref) record. */
export function dedupeSources(sources: ExternalSource[]): ExternalSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    // DataCite lists each version of a record separately (…/doi, …/doi.v1); fold them together.
    const base = s.doi.replace(/\.v\d+$/, "");
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

/** One registry, one request. Returns null on any failure so the other registry still answers. */
async function fetchJson(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<any> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      headers: { Accept: "application/json" },
      signal: controller?.signal
    });
    return response.ok ? await response.json() : null;
  } catch {
    // Timeout, DNS, malformed JSON: one fewer source is not a reason to lose the answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DataCite ANDs every term, so a five-word question matches nothing. Widening is done by
 * dropping trailing terms until something comes back — the shortest ladder that still returns a
 * record wins, which keeps relevance instead of OR-ing the query into noise.
 */
async function searchDatacite(
  term: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  limit: number
): Promise<any[]> {
  const words = term.split(/\s+/).filter(Boolean);
  const ladder = [4, 3, 2].filter((n) => words.length >= n);
  if (!ladder.length) ladder.push(words.length);
  for (const take of ladder) {
    const url = `${DATACITE}?query=${encodeURIComponent(words.slice(0, take).join(" "))}` +
      `&page[size]=${limit}`;
    const body = await fetchJson(url, doFetch, timeoutMs);
    const records: any[] = body?.data || [];
    if (records.length) return records;
  }
  return [];
}

/**
 * Queries both DOI registries in parallel. Never throws: offline, 429 or a slow registry all
 * degrade to fewer sources (worst case none), which the prompt handles as absent.
 */
export async function searchSources(query: SourceQuery): Promise<ExternalSource[]> {
  const text = clean(query.query, MAX_QUERY_CHARS);
  if (text.length < 3) return [];

  const limit = Math.min(Math.max(query.limit || DEFAULT_LIMIT, 1), 10);
  const doFetch = query.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) return [];
  const timeout = query.timeoutMs || DEFAULT_TIMEOUT;
  const term = encodeURIComponent(text);

  const [crossref, datacite] = await Promise.all([
    fetchJson(
      `${CROSSREF}?query.bibliographic=${term}&rows=${limit * 2}` +
        `&select=DOI,title,author,issued,container-title,type,is-referenced-by-count`,
      doFetch,
      timeout
    ),
    searchDatacite(text, doFetch, timeout, limit)
  ]);

  const mapped = [
    ...(crossref?.message?.items || []).map((item: any, i: number) => toSource(item, i + 1)),
    ...(datacite || []).map((item: any, i: number) => toDataciteSource(item, i + 1))
  ].filter((s): s is ExternalSource => !!s);

  // Crossref items carry citation counts and would crowd every non-journal source out of the
  // list. So rank each group, then fill: scholarly slots first, and a reserved share for the
  // reports / standards / datasets / web pages that the user asked to be able to see.
  const unique = dedupeSources(mapped);
  const isArticle = (s: ExternalSource) => s.kind === "paper" || s.kind === "book chapter";
  const ranked = rankSources(unique);
  const rankedArticles = ranked.filter(isArticle);
  const rankedOther = ranked.filter((s) => !isArticle(s));
  const reserve = Math.min(Math.max(1, Math.floor(limit / 2)), rankedOther.length);
  const keepArticles = limit - reserve;
  const picked = [
    ...rankedArticles.slice(0, keepArticles),
    ...rankedOther.slice(0, reserve)
  ];
  // Short on one side (e.g. DataCite returned nothing): backfill from whatever is left.
  if (picked.length < limit) {
    const used = new Set(picked.map((s) => s.doi));
    picked.push(
      ...ranked.filter((s) => !used.has(s.doi)).slice(0, limit - picked.length)
    );
  }

  return rankSources(picked).slice(0, limit);
}

/** One-line citation for prompts and notes: `Author et al. (2020). Title. Venue. [kind] doi:…` */
export function formatSource(source: ExternalSource): string {
  const who =
    source.authors.length > 1
      ? `${source.authors[0]} et al.`
      : source.authors[0] || "Unknown author";
  const year = source.year ? ` (${source.year})` : "";
  const venue = source.container ? ` ${source.container}.` : "";
  // The kind is always stated: a report or a web page must not read like a journal article.
  return `${who}${year}. ${source.title}.${venue} [${source.kind}] doi:${source.doi}`;
}

/**
 * Keeps only the citation markers that point at a real reference, dropping the rest.
 * A model that writes [E7] with five references gets that marker removed rather than shown,
 * so the user never sees a citation they cannot resolve.
 */
export function resolveCitations(answer: string, sources: ExternalSource[]): string {
  if (!sources.length) {
    // No references were offered: strip every marker so nothing dangles.
    return String(answer || "").replace(/\s?\[E\d+\]/g, "");
  }
  const known = new Set(sources.map((s) => s.index));
  // The leading space is part of the match so a dropped marker does not leave "word ." behind;
  // a kept marker is returned verbatim, space and all.
  return String(answer || "").replace(/ ?\[E(\d+)\]/g, (match, digits) =>
    known.has(Number(digits)) ? match : ""
  );
}

/**
 * Markdown bibliography appended to the answer. Built from the records themselves, so each line
 * is a real DOI link even if the model never mentioned it.
 */
export function citationListMarkdown(sources: ExternalSource[]): string {
  if (!sources.length) return "";
  const lines = sources.map((s) => `${s.index}. ${formatSource(s)} — ${s.url}`);
  // "consulted", not "cited": the model may cite only some of them, and claiming otherwise
  // would misrepresent what backs the answer.
  return `\n\n**Sources consulted (DOI-verified)**\n${lines.join("\n")}`;
}

/**
 * Entries of the paper's OWN reference list, taken from the full-text cache Zotero already keeps
 * (`<storage>/.zotero-ft-cache`, written by `pdfWorker.getFullText`). Nothing is fetched: a paper
 * that was never indexed simply yields no entries.
 *
 * The cache concatenates entries with inconsistent newlines — some run together on one line — so
 * entries are located by their `(YYYY)` and cut at the previous entry's start, not by newline.
 */
export function parseBibliography(fullText: string): string[] {
  const text = String(fullText || "");
  const heading = text.match(
    /\n[ \t]*(references|bibliography|reference list|works cited|daftar pustaka)[ \t]*\n/i
  );
  // No heading means no known bibliography section: guessing from the tail would match body prose.
  if (!heading || heading.index === undefined) return [];
  const body = text.slice(heading.index + heading[0].length);

  // Entries are cut at the author header that follows the previous entry's year, because the cache
  // runs entries together on one line. A header is `Surname, I.` — the shape every author list in
  // these styles starts with. ponytail: an organisation-only entry ("World Bank. (2020)") has no
  // such header and stays attached to the entry before it; add an org pattern when a paper needs it.
  const headerRe = /[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]+,\s*[A-ZÀ-Ý]\./g;
  const yearRe = /\(((?:19|20)\d{2})[a-z]?\)|\(n\.d\.\)/g;
  const years: Array<{ index: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = yearRe.exec(body))) {
    // Next author header after this year closes the entry that owns it.
    headerRe.lastIndex = m.index + m[0].length;
    const next = headerRe.exec(body);
    years.push({ index: m.index, end: next ? next.index : body.length });
  }

  const entries: string[] = [];
  let start = 0;
  for (const year of years) {
    if (year.end <= start) continue; // same entry as the one before (second year in one entry)
    const entry = body
      .slice(start, year.end)
      .replace(/\s+/g, " ")
      .trim();
    if (entry.length > 20 && entry.length < 600) entries.push(entry);
    start = year.end;
  }
  return entries;
}

/** Paren groups of author-year citations: `(Buckley & Casson, 1976; Rugman, 1981; p. 4)`. */
const CITATION_GROUP = /\(([^()]{3,300}?)\)/g;
const CITATION_PART = /^\s*(.+?),\s*((?:19|20)\d{2})[a-z]?(?::\s*\d+(?:[–-]\d+)?)?\s*$/;
/**
 * The same citation written outside parentheses — models do this when listing them as bullets
 * (`Buckley & Casson, 1976`). A surname run, a comma, then a year: prose like "In 1976" has no
 * comma, and an unmatched name fails the lookup harmlessly.
 */
const BARE_CITATION = /\b([A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]{2,}(?:\s*(?:&|and)\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]{2,})?)\s*,\s*((?:19|20)\d{2})[a-z]?\b/g;
/**
 * Narrative style: `Buckley & Casson (1976)`, `Kano et al. (2021)`. Live answers use this as often
 * as the parenthesised form, so both are needed for the citation to resolve at all.
 */
const NARRATIVE_CITATION =
  /\b([A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]{2,}(?:\s*(?:&|and)\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]{2,})?(?:\s+et\s+al\.)?)\s*\(((?:19|20)\d{2})[a-z]?\)/g;

/** `Author & Author, 1976` -> the surnames the entry must contain, plus the year. */
function splitCitation(authorPart: string, yearText: string): { surnames: string[]; year: number } | null {
  // Every surname before the year has to appear in the entry: "Verbeke & Lee, 2022" must not
  // resolve to "Hennart & Verbeke, 2022", which also has a Verbeke and a 2022.
  const surnames = (authorPart.match(/[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]+/g) || [])
    .filter((word) => word.length > 2 && !/^(et|al|and|see|cf)$/i.test(word))
    .slice(0, 2);
  if (!surnames.length) return null;
  return { surnames, year: Number(yearText) };
}

/**
 * The paper's own bibliography entries for the works the answer cites. The model cites them the
 * way the paper does — `(Buckley & Casson, 1976)` — and those names are useless to a reader who
 * cannot see the paper's reference list, so each one is resolved to the entry it came from.
 * Only entries found in the paper's own list are returned: an unmatched citation is left alone.
 */
export function citedReferences(answer: string, bibliography: string[], limit = 12): string[] {
  if (!bibliography.length) return [];
  const text = String(answer || "");
  const wanted: Array<{ surnames: string[]; year: number }> = [];
  const add = (authorPart: string, yearText: string) => {
    const parsed = splitCitation(authorPart, yearText);
    if (!parsed) return;
    const key = parsed.surnames.join("|") + parsed.year;
    if (!wanted.some((w) => w.surnames.join("|") + w.year === key)) wanted.push(parsed);
  };
  for (const group of text.matchAll(CITATION_GROUP)) {
    for (const part of group[1].split(";")) {
      const parsed = part.match(CITATION_PART);
      if (parsed) add(parsed[1], parsed[2]);
    }
  }
  for (const bare of text.matchAll(BARE_CITATION)) add(bare[1], bare[2]);
  for (const narrative of text.matchAll(NARRATIVE_CITATION)) add(narrative[1], narrative[2]);

  const hits: string[] = [];
  for (const { surnames, year } of wanted) {
    for (const entry of bibliography) {
      if (!entry.includes(String(year))) continue;
      if (!surnames.every((surname) => entry.includes(surname))) continue;
      if (!hits.includes(entry)) hits.push(entry);
      break; // one entry per cited work: same-name/year duplicates are the paper's own problem
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Rendered under the answer. Labelled as the paper's list, and quoted verbatim from it: this is
 * precisely the reference list a reader would otherwise have to scroll the PDF for.
 */
export function bibliographyMarkdown(entries: string[]): string {
  if (!entries.length) return "";
  return `\n\n**References cited from this paper**\n${entries
    .map((entry) => `- ${entry}`)
    .join("\n")}`;
}

// Words that carry no search signal. Crossref ranks by term overlap, so leaving "what", "does",
// "explain" in the query pulls in papers about explaining things rather than about the topic.
const STOPWORDS = new Set(
  (
    "a an the this that these those is are was were be been being do does did doing have has had " +
    "how what why when where which who whom whose and or but if then than so such as of in on at " +
    "to for from with without by about into over under between across per via it its their there " +
    "here we you they he she i me my our your can could should would may might must will shall " +
    "explain explains explained describe describes described tell show shows mean means meaning " +
    "paper article author authors say says said according excerpt text page p pp please " +
    // Words that name the KIND of source wanted ("a report", "a dataset", "a website") carry no
    // topic signal: left in, they make DataCite's AND query match nothing.
    "report reports dataset datasets website websites webpage web site sites document documents " +
    "study studies source sources data information overview summary review literature"
  ).split(/\s+/)
);

/**
 * Turns a question or a selection into a bibliographic query: interrogatives and stopwords are
 * dropped and the terms are capped, so "What is internalization theory and how does it explain
 * MNE expansion?" searches for "internalization theory mne expansion".
 */
export function toSearchQuery(text: unknown, maxTerms = 12): string {
  const terms = clean(text, MAX_QUERY_CHARS)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  // No content words left (a very short selection like "the firm"): fall back to the raw text
  // rather than searching for nothing.
  return terms.length ? terms.slice(0, maxTerms).join(" ") : clean(text, 120).toLowerCase();
}
