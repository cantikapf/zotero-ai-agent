/**
 * External references: only DOI-bearing records survive, citations the model invents are dropped,
 * and the bibliography is rendered from data. All offline — the network client is injected.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  citationListMarkdown,
  formatSource,
  rankSources,
  resolveCitations,
  searchSources,
  toDataciteSource,
  toSearchQuery,
  isOpinionSource,
  dedupeSources,
  toSource,
  parseBibliography,
  citedReferences,
  bibliographyMarkdown
} from "../src/sources.ts";

/** Minimal Crossref `/works` payload shape, trimmed to the fields the mapper reads. */
function crossrefItem(overrides = {}) {
  return {
    DOI: "10.1057/S42214-024-00200-8",
    title: ["Success and failure in family firm internationalization"],
    author: [
      { family: "Rothschild" },
      { family: "Bertrand" },
      { family: "Dupont" }
    ],
    issued: { "date-parts": [[2024, 5, 1]] },
    "container-title": ["Journal of International Business Studies"],
    type: "journal-article",
    "is-referenced-by-count": 12,
    ...overrides
  };
}

/** Minimal DataCite `/dois` payload shape: reports, standards, datasets, theses. */
function dataciteItem(overrides = {}) {
  const attributes = {
    doi: "10.1787/5k49cg6dw2zs-en",
    titles: [{ title: "OECD Science, Technology and Innovation Outlook" }],
    creators: [{ name: "OECD" }],
    publicationYear: 2023,
    publisher: "OECD Publishing",
    types: { resourceTypeGeneral: "Report" },
    ...overrides
  };
  return { id: attributes.doi, attributes };
}

function fakeFetch(items, init = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    // One stub answers both registries: Crossref reads message.items, DataCite reads data.
    return {
      ok: init.ok !== false,
      status: init.ok === false ? 500 : 200,
      json: async () => ({ message: { items }, data: init.datacite || [] })
    };
  };
  fn.calls = calls;
  return fn;
}

describe("toSource", () => {
  it("keeps a DOI-bearing record and normalises the DOI to lowercase", () => {
    const source = toSource(crossrefItem(), 1);
    assert.equal(source.doi, "10.1057/s42214-024-00200-8");
    assert.equal(source.url, "https://doi.org/10.1057/s42214-024-00200-8");
    assert.equal(source.year, 2024);
    assert.deepEqual(source.authors, ["Rothschild", "Bertrand", "Dupont"]);
    assert.equal(source.container, "Journal of International Business Studies");
    assert.equal(source.citedBy, 12);
  });

  it("drops records with no DOI — nothing to verify against", () => {
    assert.equal(toSource(crossrefItem({ DOI: "" }), 1), null);
    assert.equal(toSource(crossrefItem({ DOI: undefined }), 1), null);
  });

  it("decodes the HTML entities Crossref puts in titles", () => {
    const source = toSource(
      crossrefItem({ title: ["Geographically Diversified Growth, R&amp;D Intensity", ], author: [{ family: "Duran &amp; Co" }] }),
      1
    );
    assert.equal(source.title, "Geographically Diversified Growth, R&D Intensity");
    assert.deepEqual(source.authors, ["Duran & Co"]);
  });

  it("drops records with no title", () => {
    assert.equal(toSource(crossrefItem({ title: [] }), 1), null);
  });

  it("drops non-scholarly Crossref types that would read as noise", () => {
    for (const type of ["component", "peer-review", "grant"]) {
      assert.equal(toSource(crossrefItem({ type }), 1), null, type);
    }
  });

  it("tolerates a missing year and missing authors", () => {
    const source = toSource(crossrefItem({ issued: undefined, author: undefined }), 2);
    assert.equal(source.year, undefined);
    assert.deepEqual(source.authors, []);
    assert.equal(source.index, 2);
  });
});

describe("rankSources", () => {
  it("keeps relevance order within the same citation bucket and renumbers from 1", () => {
    const ranked = rankSources([
      { index: 1, title: "A", authors: [], doi: "10.1/a", url: "u", citedBy: 3 },
      { index: 2, title: "B", authors: [], doi: "10.1/b", url: "u", citedBy: 10 }
    ]);
    assert.deepEqual(ranked.map((s) => s.title), ["A", "B"]);
    assert.deepEqual(ranked.map((s) => s.index), [1, 2]);
  });

  it("floats a heavily cited paper above a near-tie", () => {
    const ranked = rankSources([
      { index: 1, title: "Obscure", authors: [], doi: "10.1/a", url: "u", citedBy: 1 },
      { index: 2, title: "Seminal", authors: [], doi: "10.1/b", url: "u", citedBy: 900 }
    ]);
    assert.deepEqual(ranked.map((s) => s.title), ["Seminal", "Obscure"]);
  });
});

describe("searchSources", () => {
  it("asks Crossref for bibliographic matches and returns mapped records", async () => {
    const fetchImpl = fakeFetch([crossrefItem()]);
    const sources = await searchSources({ query: "internalization theory", fetchImpl });
    assert.equal(sources.length, 1);
    assert.match(fetchImpl.calls[0], /api\.crossref\.org\/works\?query\.bibliographic=internalization/);
    assert.match(fetchImpl.calls[0], /rows=/);
  });

  it("honours the limit and defaults to 5", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      crossrefItem({ DOI: `10.1/x${i}`, title: [`Paper ${i}`] })
    );
    assert.equal((await searchSources({ query: "theory", fetchImpl: fakeFetch(many) })).length, 5);
    assert.equal(
      (await searchSources({ query: "theory", limit: 2, fetchImpl: fakeFetch(many) })).length,
      2
    );
  });

  it("returns nothing for a query too short to be meaningful", async () => {
    const fetchImpl = fakeFetch([crossrefItem()]);
    assert.deepEqual(await searchSources({ query: " ab ", fetchImpl }), []);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("degrades to no sources when the registry errors", async () => {
    assert.deepEqual(await searchSources({ query: "theory", fetchImpl: fakeFetch([], { ok: false }) }), []);
  });

  it("never throws when the network itself fails", async () => {
    const boom = async () => {
      throw new Error("ENOTFOUND api.crossref.org");
    };
    assert.deepEqual(await searchSources({ query: "theory", fetchImpl: boom }), []);
  });

  it("survives a malformed payload", async () => {
    const bad = async () => ({ ok: true, json: async () => ({ message: {} }) });
    assert.deepEqual(await searchSources({ query: "theory", fetchImpl: bad }), []);
  });
});

describe("resolveCitations", () => {
  const sources = rankSources([
    { index: 1, title: "A", authors: ["Rothschild"], doi: "10.1/a", url: "https://doi.org/10.1/a" },
    { index: 2, title: "B", authors: ["Dupont"], doi: "10.1/b", url: "https://doi.org/10.1/b" }
  ]);

  it("keeps markers that point at a real reference", () => {
    const answer = "Families trade FSAs [E1] and governance [E2].";
    assert.equal(resolveCitations(answer, sources), answer);
  });

  it("strips a marker the model invented beyond the list", () => {
    const out = resolveCitations("As shown [E1] and elsewhere [E7].", sources);
    assert.equal(out, "As shown [E1] and elsewhere.");
  });

  it("strips every marker when no references were offered", () => {
    assert.equal(resolveCitations("A claim [E1] and another [E2].", []), "A claim and another.");
  });

  it("leaves ordinary text untouched", () => {
    assert.equal(resolveCitations("No citations here.", sources), "No citations here.");
  });
});

describe("formatSource", () => {
  it("builds an Author et al. (year). Title. Venue. doi line", () => {
    const line = formatSource(toSource(crossrefItem(), 1));
    assert.match(line, /^Rothschild et al\. \(2024\)\. Success and failure/);
    assert.match(line, /Journal of International Business Studies\./);
    assert.match(line, /doi:10\.1057\/s42214-024-00200-8$/);
  });

  it("says Unknown author rather than inventing one, and omits a missing year", () => {
    const line = formatSource({
      index: 1, title: "T", authors: [], doi: "10.1/a", url: "u", kind: "document"
    });
    assert.equal(line, "Unknown author. T. [document] doi:10.1/a");
  });

  it("labels a non-article source so it cannot pass as a journal paper", () => {
    const report = formatSource({
      index: 1, title: "World Investment Report", authors: ["UNCTAD"], year: 2024,
      doi: "10.1/r", url: "u", kind: "report"
    });
    assert.match(report, /\[report\] doi:10\.1\/r$/);
  });
});

describe("citationListMarkdown", () => {
  it("renders a numbered, linked list straight from the records", () => {
    const md = citationListMarkdown([
      { index: 1, title: "A", authors: [], doi: "10.1/a", url: "https://doi.org/10.1/a", kind: "document" }
    ]);
    assert.match(md, /\*\*Sources consulted \(DOI-verified\)\*\*/);
    assert.match(md, /1\. Unknown author\. A\. \[document\] doi:10\.1\/a — https:\/\/doi\.org\/10\.1\/a/);
  });

  it("renders nothing when there are no sources", () => {
    assert.equal(citationListMarkdown([]), "");
  });
});

describe("toSearchQuery", () => {
  it("strips the question scaffolding so the topic terms drive the search", () => {
    assert.equal(
      toSearchQuery("What is internalization theory and how does it explain MNE expansion?"),
      "internalization theory mne expansion"
    );
  });

  it("keeps a selection as-is apart from case, since it is already the topic", () => {
    assert.equal(toSearchQuery("Firm-specific advantages"), "firm-specific advantages");
  });

  it("keeps whatever content word survives an all-stopword phrase", () => {
    assert.equal(toSearchQuery("the firm"), "firm");
  });

  it("falls back to the raw text when nothing survives", () => {
    assert.equal(toSearchQuery("it does"), "it does");
  });

  it("is used for the lookup, so the request carries topic terms only", async () => {
    const fetchImpl = fakeFetch([crossrefItem()]);
    await searchSources({ query: toSearchQuery("How does it explain FSAs?"), fetchImpl });
    assert.match(fetchImpl.calls[0], /query\.bibliographic=fsas&/);
  });
});

describe("toDataciteSource", () => {
  it("maps a report, so a non-journal source can still be cited", () => {
    const source = toDataciteSource(dataciteItem(), 1);
    assert.equal(source.doi, "10.1787/5k49cg6dw2zs-en");
    assert.equal(source.title, "OECD Science, Technology and Innovation Outlook");
    assert.equal(source.year, 2023);
    assert.equal(source.container, "OECD Publishing");
    assert.equal(source.kind, "report");
    assert.deepEqual(source.authors, ["OECD"]);
  });

  it("labels datasets, standards and theses distinctly", () => {
    const kinds = ["Dataset", "Standard", "Text", "Dissertation", "Software"].map((type) =>
      toDataciteSource(
        dataciteItem({ types: { resourceTypeGeneral: type }, doi: `10.1/${type}` }),
        1
      ).kind
    );
    assert.deepEqual(kinds, ["dataset", "standard", "document", "thesis", "software"]);
  });

  it("drops a record with no DOI or no title", () => {
    assert.equal(toDataciteSource(dataciteItem({ doi: "" }), 1), null);
    assert.equal(toDataciteSource(dataciteItem({ titles: [] }), 1), null);
  });
});

describe("opinion filtering", () => {
  it("rejects blogging platforms even when they hand out DOIs", () => {
    for (const host of ["medium.com", "substack.com", "acme.wordpress.com", "dev.to"]) {
      assert.equal(isOpinionSource(`10.1234/${host}`, ""), true, host);
      assert.equal(
        toDataciteSource(dataciteItem({ publisher: `Blog on ${host}` }), 1),
        null,
        host
      );
    }
  });

  it("rejects commentary venues by wording", () => {
    assert.equal(toSource(crossrefItem({ "container-title": ["Staff Blog"] }), 1), null);
    assert.equal(
      toSource(crossrefItem({ "container-title": ["Journal of Public Opinion Research"] }), 1).kind,
      "paper",
      "a journal with 'opinion' in its name stays"
    );
  });

  it("keeps an institutional report, which is not a journal article but is a real source", () => {
    const kept = toSource(
      crossrefItem({ type: "report", "container-title": ["World Bank"], title: ["Poverty Report"] }),
      1
    );
    assert.equal(kept.kind, "report");
  });
});

describe("searchSources across both registries", () => {
  it("merges Crossref and DataCite results", async () => {
    const fetchImpl = fakeFetch([crossrefItem()], { datacite: [dataciteItem()] });
    const sources = await searchSources({ query: "innovation outlook", fetchImpl });
    assert.equal(sources.length, 2);
    assert.deepEqual(
      sources.map((s) => s.kind).sort(),
      ["paper", "report"]
    );
    assert.ok(fetchImpl.calls.some((u) => u.includes("api.datacite.org")));
    assert.ok(fetchImpl.calls.some((u) => u.includes("api.crossref.org")));
  });

  it("dedupes a DOI both registries returned", () => {
    const a = { index: 1, title: "A", authors: [], doi: "10.1/x", url: "u", kind: "paper" };
    const b = { index: 2, title: "A again", authors: [], doi: "10.1/x", url: "u", kind: "report" };
    assert.deepEqual(dedupeSources([a, b]).map((s) => s.title), ["A"]);
  });

  it("still answers from the other registry when one is down", async () => {
    const onlyCrossref = async (url) => ({
      ok: url.includes("crossref"),
      json: async () => (url.includes("crossref") ? { message: { items: [crossrefItem()] } } : {})
    });
    const sources = await searchSources({ query: "internalization", fetchImpl: onlyCrossref });
    assert.equal(sources.length, 1);
  });
});

describe("registry balance", () => {
  it("keeps a non-journal source in the list even when articles are heavily cited", async () => {
    // Five heavily cited articles from Crossref, one report from DataCite: without a reserved
    // share the report would never reach the user.
    const items = [1, 2, 3, 4, 5].map((n) =>
      crossrefItem({ DOI: `10.1/article${n}`, "is-referenced-by-count": n * 500 })
    );
    const fetchImpl = fakeFetch(items, { datacite: [dataciteItem()] });
    const sources = await searchSources({ query: "family firm internationalization", fetchImpl });
    const kinds = sources.map((s) => s.kind);
    assert.ok(kinds.includes("report"), `expected a report, got ${kinds.join(",")}`);
    assert.equal(sources.length, 5);
  });

  it("stays all-article when the other registry has nothing to add", async () => {
    const fetchImpl = fakeFetch([crossrefItem()], { datacite: [] });
    const sources = await searchSources({ query: "internalization theory", fetchImpl });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].kind, "paper");
  });
});

/**
 * The paper's own reference list: parsed from Zotero's full-text cache, and the author-year
 * citations the answer inherits from the paper are resolved to real entries. The fixture mirrors
 * the real cache shape — entries run together on one line, the heading sits on its own line.
 */
describe("paper bibliography from the full-text cache", () => {
  const CACHE = [
    "Body prose that cites (Buckley & Casson, 1976) but is not a reference entry.",
    "References",
    "Baring Archive. n.d. Timeline - The Baring Archive. https://baringarchive.org.uk/. Accessed 15 July 2023. " +
      "Argyres, N. S., De Massis, A., & Silverman, B. S. (2020). History-informed strategy research. " +
      "Strategic Management Journal, 41(3), 343–368.",
    "Buckley, P. J., & Casson, M. (1976). The Future of the Multinational Enterprise. London: Macmillan.",
    "Hennart, J.-F., & Verbeke, A. (2022). Actionable and enduring implications. Journal of International " +
      "Business Studies, 53(8), 1557–1575.",
    "Verbeke, A., & Lee, I. H. I. (2022). International Business Strategy (3rd ed.). Cambridge: Cambridge " +
      "University Press.",
    "Publisher’s Note Springer Nature remains neutral."
  ].join("\n");

  it("splits entries that the cache glued onto one line", () => {
    const entries = parseBibliography(CACHE);
    assert.equal(entries.length, 4);
    assert.ok(entries[1].startsWith("Buckley, P. J., & Casson, M. (1976)."));
    assert.ok(entries[3].includes("International Business Strategy"));
    // The body prose before the heading must never become an entry.
    assert.ok(!entries.some((entry) => entry.startsWith("Body prose")));
  });

  it("returns nothing when the cache has no reference section", () => {
    assert.deepEqual(parseBibliography("Just prose, no heading here."), []);
    assert.deepEqual(parseBibliography(""), []);
  });

  it("resolves every author of a citation, so a shared surname picks the right entry", () => {
    const entries = parseBibliography(CACHE);
    const answer = "FSAs cross borders (Buckley & Casson, 1976; p. 4) and are distinct " +
      "(Verbeke & Lee, 2022: 5; p. 4).";
    const refs = citedReferences(answer, entries);
    assert.equal(refs.length, 2);
    assert.ok(refs[0].includes("The Future of the Multinational Enterprise"));
    // Both entries carry a Verbeke and a 2022; only the one with Lee may match.
    assert.ok(refs[1].includes("International Business Strategy"));
    assert.ok(!refs[1].includes("Actionable and enduring"));
  });

  it("drops citations the paper's list does not contain, and repeats nothing", () => {
    const entries = parseBibliography(CACHE);
    const answer = "(Ghost & Author, 1999; Hennart & Verbeke, 2022; p. 3) and again (Hennart & Verbeke, 2022).";
    const refs = citedReferences(answer, entries);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].startsWith("Hennart, J.-F., & Verbeke, A. (2022)."));
  });

  it("ignores page references and prose in parentheses", () => {
    const entries = parseBibliography(CACHE);
    assert.deepEqual(citedReferences("See (p. 4) and (as noted above) and (see Figure 2).", entries), []);
  });

  it("renders a labelled list, and nothing at all when empty", () => {
    const entries = parseBibliography(CACHE);
    const md = bibliographyMarkdown([entries[1]]);
    assert.match(md, /\*\*References cited from this paper\*\*/);
    assert.match(md, /^- Buckley, P\. J\., & Casson, M\. \(1976\)\./m);
    assert.equal(bibliographyMarkdown([]), "");
  });
});

/** A model that lists the paper's citations as bullets writes them without parentheses. */
describe("author-year citations written outside parentheses", () => {
  const BIB = [
    "Buckley, P. J., & Casson, M. (1976). The Future of the Multinational Enterprise. London: Macmillan.",
    "Hennart, J.-F., & Verbeke, A. (2022). Actionable and enduring implications. Journal of International Business Studies, 53(8), 1557–1575.",
    "Verbeke, A., & Lee, I. H. I. (2022). International Business Strategy (3rd ed.). Cambridge: Cambridge University Press."
  ];

  it("resolves a bulleted citation", () => {
    const refs = citedReferences("- `Buckley & Casson, 1976` (p. 4)", BIB);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].includes("The Future of the Multinational Enterprise"));
  });

  it("still needs every surname, so a shared name picks the right entry", () => {
    const refs = citedReferences("Verbeke & Lee, 2022", BIB);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].includes("International Business Strategy"));
  });

  it("does not treat a bare year in prose as a citation", () => {
    assert.deepEqual(citedReferences("In 1976 the firm expanded (p. 5).", BIB), []);
  });
});

/** Narrative style — "Buckley & Casson (1976)" — is what live answers actually write. */
describe("narrative author (year) citations", () => {
  const BIB = [
    "Buckley, P. J., & Casson, M. (1976). The Future of the Multinational Enterprise. London: Macmillan.",
    "Kano, L., Ciravegna, L., & Rattalino, F. (2021). The family as a platform for FSA development. Global Strategy Journal.",
    "Verbeke, A., & Lee, I. H. I. (2022). International Business Strategy (3rd ed.). Cambridge: Cambridge University Press."
  ];

  it("resolves a narrative citation, including et al.", () => {
    const refs = citedReferences(
      "- Buckley & Casson (1976) (p. 4)\n- Kano et al. (2021) (p. 3)",
      BIB
    );
    assert.equal(refs.length, 2);
    assert.ok(refs[0].includes("The Future of the Multinational Enterprise"));
    assert.ok(refs[1].includes("The family as a platform"));
  });

  it("keeps the shared-surname rule for narrative citations", () => {
    const refs = citedReferences("Verbeke & Lee (2022)", BIB);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].includes("International Business Strategy"));
  });

  it("does not fire on an ordinary year in parentheses", () => {
    assert.deepEqual(citedReferences("The firm expanded (1976) quickly (p. 5).", BIB), []);
  });
});
