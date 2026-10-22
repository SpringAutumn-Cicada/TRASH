import assert from "node:assert/strict";
import test from "node:test";
import { OpenAlexProvider, fetchPublicWebpage, parseImportedFile, parseWebpage } from "../src/index.js";

function makeOnePagePdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

test("Markdown parsing keeps heading and paragraph locators", async () => {
  const parsed = await parseImportedFile("paper.md", new TextEncoder().encode("# Related Work\n\nAPT campaigns often use lateral movement.\n\n## Detection\n\nProvenance supports behavior analysis."));
  assert.equal(parsed[0].title, "Related Work");
  assert.deepEqual(parsed[0].segments.map((segment) => segment.locator), [
    { kind: "paragraph", paragraph_index: 1, heading: "Related Work" },
    { kind: "paragraph", paragraph_index: 2, heading: "Detection" }
  ]);
});

test("PDF extraction stores a page locator for extracted text", async () => {
  const parsed = await parseImportedFile("apt-paper.pdf", makeOnePagePdf("APT provenance evidence"));
  assert.equal(parsed[0].parse_status, "indexed");
  assert.deepEqual(parsed[0].segments[0].locator, { kind: "pdf_page", page_number: 1 });
  assert.match(parsed[0].segments[0].text, /APT provenance evidence/);
});

test("BibTeX and RIS records normalize into searchable metadata and abstract segments", async () => {
  const bib = await parseImportedFile("refs.bib", new TextEncoder().encode("@article{one, title={Provenance for APT}, author={Ada Lovelace and Alan Turing}, year={2024}, doi={10.1/demo}, abstract={Graphs improve detection.}}"));
  assert.equal(bib.length, 1);
  assert.equal(bib[0].title, "Provenance for APT");
  assert.equal(bib[0].year, 2024);
  assert.equal(bib[0].segments[0].locator.kind, "abstract");
  const ris = await parseImportedFile("refs.ris", new TextEncoder().encode("TY  - JOUR\nTI  - Tracing APT activity\nAU  - Ada Lovelace\nPY  - 2022\nAB  - Provenance evidence links process events.\nER  -"));
  assert.equal(ris[0].source_type, "ris");
  assert.equal(ris[0].authors[0], "Ada Lovelace");
  assert.equal(ris[0].year, 2022);
  assert.equal(ris[0].parse_status, "indexed");
});

test("malformed bibliography is marked failed and unsupported formats are rejected", async () => {
  const malformed = await parseImportedFile("bad.bib", new TextEncoder().encode("not a bibliography"));
  assert.equal(malformed[0].parse_status, "failed");
  assert.equal(malformed[0].segments.length, 0);
  await assert.rejects(parseImportedFile("paper.docx", new Uint8Array()), { message: "UNSUPPORTED_FILE_TYPE" });
});

test("webpage parser strips navigation and keeps URL, paragraph and heading locators", () => {
  const parsed = parseWebpage(new TextEncoder().encode("<html><head><title>Study</title></head><body><nav>Menu</nav><main><h1>APT Study</h1><h2>Method</h2><p>Provenance graph detects behavior.</p><script>secret()</script></main></body></html>"), "https://example.org/paper");
  assert.equal(parsed.title, "APT Study");
  assert.deepEqual(parsed.segments[0].locator, { kind: "paragraph", paragraph_index: 1, heading: "Method", url: "https://example.org/paper" });
  assert.equal(parsed.segments[0].text.includes("Menu"), false);
  assert.equal(parsed.segments[0].text.includes("secret"), false);
});

test("URL importer rejects private destinations and rechecks redirect targets", async () => {
  let fetchCount = 0;
  const fakeTransport = async () => {
    fetchCount += 1;
    return { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: new Uint8Array() };
  };
  await assert.rejects(fetchPublicWebpage("http://127.0.0.1/paper", fakeTransport), { message: "URL_HOST_NOT_PUBLIC" });
  await assert.rejects(fetchPublicWebpage("http://93.184.216.34/paper", fakeTransport), { message: "URL_HOST_NOT_PUBLIC" });
  assert.equal(fetchCount, 1);
});

test("OpenAlex provider maps records, reconstructs abstracts and caps per-page count", async () => {
  let requestedUrl = "";
  const provider = new OpenAlexProvider({ apiKey: "test-secret", fetcher: async (input, init) => {
    requestedUrl = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
    return Response.json({ results: [{
      id: "https://openalex.org/W1", title: "APT provenance", publication_year: 2023, doi: "https://doi.org/10.1/apt",
      authorships: [{ author: { display_name: "Ada Lovelace" } }],
      primary_location: { landing_page_url: "https://example.org/paper" },
      abstract_inverted_index: { APT: [0], behavior: [1], detection: [2] }
    }] });
  } });
  const results = await provider.search("APT detection", 200);
  assert.equal(results[0].abstract, "APT behavior detection");
  assert.equal(results[0].doi, "10.1/apt");
  assert.match(requestedUrl, /per_page=50/);
  assert.equal(requestedUrl.includes("test-secret"), false);
});
