import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearConnection,
  connectWithCode,
  getConnection,
  setConnection,
} from '../src/connection.js';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('server connection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is unconfigured without storage or content', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getConnection()).toBeNull();
  });

  it('round-trips a valid connection', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const conn = setConnection('http://192.168.100.43:8787', 'tok123');
    expect(conn).toEqual({ url: 'http://192.168.100.43:8787', token: 'tok123' });
    expect(getConnection()).toEqual(conn);
  });

  it('rejects corrupt or hostile stored content', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    store.setItem('takalif-server', 'not json');
    expect(getConnection()).toBeNull();
    store.setItem('takalif-server', JSON.stringify({ url: 'http://h', token: '' }));
    expect(getConnection()).toBeNull();
    store.setItem('takalif-server', JSON.stringify({ url: 'javascript:x', token: 't' }));
    expect(getConnection()).toBeNull();
  });

  it('accepts a pasted QR payload and clears cleanly', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const conn = connectWithCode('{"v":1,"url":"http://h:1","token":"t"}');
    expect(conn).toEqual({ url: 'http://h:1', token: 't' });
    expect(getConnection()).toEqual(conn);
    expect(() => connectWithCode('garbage')).toThrow(/not JSON/);
    clearConnection();
    expect(getConnection()).toBeNull();
  });

  it('refuses to store invalid input', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(() => setConnection('http://h', '')).toThrow(/token/);
    expect(() => setConnection('notaurl', 't')).toThrow();
  });
});
