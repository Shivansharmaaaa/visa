'use strict';

const { validateJobId, extractAppId } = require('../../src/setup');

// ── validateJobId ─────────────────────────────────────────────────────────────

describe('validateJobId', () => {
  test('accepts valid Job IDs', () => {
    expect(validateJobId('JOB-AB-12345')).toBe(true);
    expect(validateJobId('JOB-ZZ-0')).toBe(true);
    expect(validateJobId('JOB-CA-999999')).toBe(true);
  });

  test('rejects lowercase letters in the two-letter code', () => {
    expect(validateJobId('JOB-ab-123')).toBe(false);
    expect(validateJobId('JOB-Ab-123')).toBe(false);
  });

  test('rejects missing prefix', () => {
    expect(validateJobId('AB-12345')).toBe(false);
    expect(validateJobId('12345')).toBe(false);
  });

  test('rejects non-digit suffix', () => {
    expect(validateJobId('JOB-AB-12X')).toBe(false);
    expect(validateJobId('JOB-AB-')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateJobId('')).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(validateJobId(null)).toBe(false);
    expect(validateJobId(undefined)).toBe(false);
    expect(validateJobId(123)).toBe(false);
  });
});

// ── extractAppId ──────────────────────────────────────────────────────────────

describe('extractAppId', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const UUID2 = '11111111-2222-3333-4444-555555555555';
  const UUID3 = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';

  test('returns data.applicationId when present', () => {
    const res = { data: { applicationId: UUID } };
    expect(extractAppId(res)).toBe(UUID);
  });

  test('returns errorMetadata.applicationId when data.applicationId is absent', () => {
    const res = { errorMetadata: { applicationId: UUID2 } };
    expect(extractAppId(res)).toBe(UUID2);
  });

  test('returns data.existingApplicationId as last resort', () => {
    const res = { data: { existingApplicationId: UUID3 } };
    expect(extractAppId(res)).toBe(UUID3);
  });

  test('priority: data.applicationId over errorMetadata.applicationId', () => {
    const res = {
      data: { applicationId: UUID },
      errorMetadata: { applicationId: UUID2 },
    };
    expect(extractAppId(res)).toBe(UUID);
  });

  test('priority: errorMetadata.applicationId over data.existingApplicationId', () => {
    const res = {
      data: { existingApplicationId: UUID3 },
      errorMetadata: { applicationId: UUID2 },
    };
    expect(extractAppId(res)).toBe(UUID2);
  });

  test('returns null when no appId fields present', () => {
    expect(extractAppId({})).toBeNull();
    expect(extractAppId({ data: {} })).toBeNull();
    expect(extractAppId({ data: null })).toBeNull();
  });

  test('returns null for non-object input', () => {
    expect(extractAppId(null)).toBeNull();
    expect(extractAppId(undefined)).toBeNull();
    expect(extractAppId('string')).toBeNull();
  });
});
