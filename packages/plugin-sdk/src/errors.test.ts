import { describe, expect, it } from 'vitest';
import { PluginCollisionError, PluginNotFoundError } from './errors.js';

describe('error classes', () => {
  it('PluginCollisionError carries code PLUGIN_COLLISION and the message', () => {
    const err = new PluginCollisionError('duplicate id "x"');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('PLUGIN_COLLISION');
    expect(err.message).toBe('duplicate id "x"');
  });

  it('PluginNotFoundError carries code UNSUPPORTED and the message', () => {
    const err = new PluginNotFoundError('no plugin for "x"');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('UNSUPPORTED');
    expect(err.message).toBe('no plugin for "x"');
  });
});