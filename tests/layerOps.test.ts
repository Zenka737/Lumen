import { describe, expect, it } from 'vitest';
import { copyName, indexAfterDelete, moveItem, nextLayerName, uniqueName } from '../src/core/layerOps';

describe('layer list operations', () => {
  it('moveItem moves up and down without mutating', () => {
    const a = ['a', 'b', 'c', 'd'];
    expect(moveItem(a, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(a, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(a).toEqual(['a', 'b', 'c', 'd']);
  });
  it('moveItem clamps target and ignores invalid source', () => {
    expect(moveItem([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
  it('nextLayerName increments the highest number', () => {
    expect(nextLayerName([])).toBe('Слой 1');
    expect(nextLayerName(['Фон', 'Слой 1', 'Слой 7'])).toBe('Слой 8');
  });
  it('uniqueName / copyName avoid duplicates', () => {
    expect(uniqueName('Текст', ['Текст'])).toBe('Текст 2');
    expect(copyName('Фон', ['Фон'])).toBe('Фон копия');
    expect(copyName('Фон копия', ['Фон', 'Фон копия'])).toBe('Фон копия 2');
  });
  it('indexAfterDelete picks a sensible neighbour', () => {
    expect(indexAfterDelete(0, 3)).toBe(0);
    expect(indexAfterDelete(2, 3)).toBe(1);
    expect(indexAfterDelete(0, 1)).toBe(-1);
  });
});
