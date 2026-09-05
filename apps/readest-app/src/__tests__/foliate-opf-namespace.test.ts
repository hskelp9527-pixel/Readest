// Regression test for an import failure on EPUBs whose OPF root element is not
// in the OPF namespace.
//
// foliate-js decided whether to match package children by namespace with
// "does this namespace appear in the document at all":
//
//   const useNS = doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns)
//
// Plenty of EPUB 2 files (and repacked ones) declare `xmlns:opf` only to carry
// `opf:role` / `opf:file-as` attributes, while `<package>` itself has no
// default namespace at all. `lookupPrefix(NS.OPF)` then returns "opf", strict
// matching switches on, and `<metadata>` / `<manifest>` / `<spine>` — whose
// namespaceURI is null — match nothing. `getMetadata()` dies on
// `$metadata.children` and import reports
// "Failed to open the book file: Cannot read properties of undefined (reading 'children')".
//
// The fix keys the decision off the root element's own namespace, so a package
// that isn't in the OPF namespace falls back to matching by local name.
import { describe, expect, it } from 'vitest';

import { parseEpubMetadataFromXML } from 'foliate-js/epub.js';

const DC = 'xmlns:dc="http://purl.org/dc/elements/1.1/"';
const body = (prefix = '') => `
  <${prefix}metadata>
    <dc:title>Book Title</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Doe, Jane">Jane Doe</dc:creator>
    <dc:publisher opf:file-as="Press, Acme">Acme Press</dc:publisher>
    <dc:identifier id="BookId">urn:uuid:1</dc:identifier>
    <dc:language>en</dc:language>
  </${prefix}metadata>
  <${prefix}manifest>
    <${prefix}item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
  </${prefix}manifest>
  <${prefix}spine><${prefix}itemref idref="cover"/></${prefix}spine>`;

describe('OPF root namespace handling', () => {
  it('parses an OPF whose package has no default namespace (the reported bug)', () => {
    // `xmlns:opf` is declared for the opf: attributes only; the elements
    // themselves are in no namespace.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns:opf="http://www.idpf.org/2007/opf" ${DC} version="2.0" unique-identifier="BookId">${body()}
</package>`;
    const { metadata } = parseEpubMetadataFromXML(xml);
    expect(metadata.title).toBe('Book Title');
    // the `opf:` attributes are still read, proving the fallback only relaxed
    // element matching and didn't lose namespaced attribute handling
    expect(metadata.publisher).toMatchObject({ name: 'Acme Press', sortAs: 'Press, Acme' });
  });

  it('parses a standard EPUB 3 OPF (default OPF namespace)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" ${DC} version="3.0" unique-identifier="BookId">${body()}
</package>`;
    const { metadata } = parseEpubMetadataFromXML(xml);
    expect(metadata.title).toBe('Book Title');
    expect(metadata.language).toBe('en');
  });

  it('parses an OPF whose package element is namespace-prefixed', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" ${DC} version="2.0" unique-identifier="BookId">${body('opf:')}
</opf:package>`;
    const { metadata } = parseEpubMetadataFromXML(xml);
    expect(metadata.title).toBe('Book Title');
  });
});
