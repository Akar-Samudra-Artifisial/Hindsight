import { describe, expect, it } from 'vitest';
import { buildDossier, dossierId, dossierText, MAX_TRACKED_DOSSIERS, parseDossierIds, withDossierId } from '../src/core/dossier';

const base = {
  incidentKey: 'INC-1',
  siteUrl: 'https://one-atlas-vyyd.atlassian.net/',
  windowDays: 30,
  candidateCount: 5,
  earliestDaysBefore: 12,
  now: new Date('2026-11-03T10:00:00.000Z'),
};

describe('buildDossier', () => {
  it('has a stable id per incident, the incident URL and EVERYONE permission', () => {
    const doc = buildDossier(base);
    expect(doc.id).toBe('dossier-inc-1');
    expect(dossierId('INC-1')).toBe(doc.id);
    expect(doc.displayName).toBe('Early signals for INC-1');
    expect(doc.url).toBe('https://one-atlas-vyyd.atlassian.net/browse/INC-1');
    expect(doc.permissions).toEqual([{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }]);
    expect(doc['atlassian:document'].content).toEqual({ mimeType: 'text/plain', text: dossierText(base) });
  });

  it('text holds only counts and the incident key (no summary, titles or quotes)', () => {
    const text = dossierText(base);
    expect(text).toBe(
      'Hindsight analysed INC-1: 5 candidate early signals in the 30 days before the incident; the earliest 12 days before. Open the Hindsight panel on INC-1 to review them.',
    );
    expect(text).not.toMatch(/checkout|payment|"/i);
  });

  it('handles zero and one candidate', () => {
    expect(dossierText({ ...base, candidateCount: 0, earliestDaysBefore: null })).toBe('Hindsight analysed INC-1: no candidate early signals in the 30 days before the incident.');
    expect(dossierText({ ...base, candidateCount: 1, earliestDaysBefore: 1 })).toContain('1 candidate early signal in the 30 days before the incident; the earliest 1 day before');
  });

  it('updateSequenceNumber increases with time so a later write replaces the earlier one', () => {
    const later = buildDossier({ ...base, now: new Date('2026-11-03T10:05:00.000Z') });
    expect(later.updateSequenceNumber).toBeGreaterThan(buildDossier(base).updateSequenceNumber);
  });
});

describe('tracked dossier ids', () => {
  it('parses only a list of non-empty strings', () => {
    expect(parseDossierIds(['a', 2, '', 'b'])).toEqual(['a', 'b']);
    expect(parseDossierIds('a')).toEqual([]);
    expect(parseDossierIds(undefined)).toEqual([]);
  });
  it('adds without duplicates and keeps at most MAX_TRACKED_DOSSIERS', () => {
    expect(withDossierId(['a', 'b'], 'a')).toEqual(['b', 'a']);
    const many = Array.from({ length: MAX_TRACKED_DOSSIERS }, (_, i) => `d${i}`);
    const next = withDossierId(many, 'new');
    expect(next).toHaveLength(MAX_TRACKED_DOSSIERS);
    expect(next.at(-1)).toBe('new');
    expect(next[0]).toBe('d1');
  });
});
