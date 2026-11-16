import { describe, expect, it } from 'vitest';
import { renderTokenValues } from './generator-token-values.ts';

describe('JavaScript token projection', () => {
  it('projects only declared values and normalizes duration units', () => {
    const output = renderTokenValues(
      { duration: '0.22s', radius: '0.5rem', privateAuthoring: 'excluded' },
      {
        exportName: 'parameters',
        bindings: [
          { path: ['duration', 'control'], sourcePointer: '/duration', format: 'milliseconds' },
          { path: ['radius'], sourcePointer: '/radius' },
        ],
      },
    );
    expect(output).toContain('control: 220');
    expect(output).toContain("radius: '0.5rem'");
    expect(output).not.toContain('privateAuthoring');
  });
  it('rejects missing source, unsupported units and duplicate output paths', () => {
    const options = {
      exportName: 'tokens',
      bindings: [
        { path: ['duration'], sourcePointer: '/duration', format: 'milliseconds' as const },
      ],
    };
    expect(() => renderTokenValues({}, options)).toThrow('悬空');
    expect(() => renderTokenValues({ duration: 'calc(1ms)' }, options)).toThrow('单位');
    expect(() =>
      renderTokenValues(
        { duration: '10ms' },
        { ...options, bindings: [...options.bindings, ...options.bindings] },
      ),
    ).toThrow('重复');
  });
  it('rejects prototype paths and source-code-shaped export names', () => {
    expect(() =>
      renderTokenValues(
        { value: 1 },
        {
          exportName: 'tokens;throw Error()',
          bindings: [{ path: ['value'], sourcePointer: '/value' }],
        },
      ),
    ).toThrow('identifier');
    expect(() =>
      renderTokenValues(
        { value: 1 },
        {
          exportName: 'tokens',
          bindings: [{ path: ['__proto__', 'value'], sourcePointer: '/value' }],
        },
      ),
    ).toThrow('identifier');
  });
});
