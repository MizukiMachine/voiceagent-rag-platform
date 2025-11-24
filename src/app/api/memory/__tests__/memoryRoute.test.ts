import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DELETE as resetMemory } from '../route';

const storeMock = vi.hoisted(() => ({
  reset: vi.fn(),
}));

vi.mock('../../../../../services/coreData/persistentMemory', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../services/coreData/persistentMemory')
  >('../../../../../services/coreData/persistentMemory');
  return {
    ...actual,
    getPersistentMemoryStore: () => storeMock,
  };
});

describe('memory API route', () => {
  beforeEach(() => {
    storeMock.reset.mockReset();
    delete process.env.BFF_SERVICE_SHARED_SECRET;
  });

  it('resets persistent memory via DELETE /api/memory', async () => {
    const request = new Request('http://localhost/api/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSetKey: 'demo' }),
    });

    const response = await resetMemory(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(storeMock.reset).toHaveBeenCalledWith('demo');
  });

  it('resolves memoryKey using clientTag when provided', async () => {
    const request = new Request('http://localhost/api/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSetKey: 'demo', clientTag: 'glasses01' }),
    });

    const response = await resetMemory(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.memoryKey).toBe('demo:glasses01');
    expect(storeMock.reset).toHaveBeenCalledWith('demo:glasses01');
  });

  it('rejects unauthorized calls when secret is set', async () => {
    process.env.BFF_SERVICE_SHARED_SECRET = 'secret';
    const request = new Request('http://localhost/api/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSetKey: 'demo' }),
    });

    const response = await resetMemory(request);
    expect(response.status).toBe(401);
  });
});
